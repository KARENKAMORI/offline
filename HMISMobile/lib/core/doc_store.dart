import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:sqflite/sqflite.dart';
import 'package:uuid/uuid.dart';

import '../src/rust/api/doc.dart';
import 'db.dart';
import 'device_profile.dart';
import 'models.dart';
import 'schema.dart';

export '../src/rust/api/doc.dart' show DocField;

/// A value to write into a document map.
DocField textField(String key, String value) => DocField(key: key, text: value);
DocField flagField(String key, bool value) => DocField(key: key, flag: value);

/// What merging a synced copy into the stored document did.
class MergeResult {
  const MergeResult({required this.received, required this.fromDevices});

  /// Changes that were new to this phone.
  final int received;

  /// Names of the devices that made them ("the server" when unnamed).
  final Set<String> fromDevices;
}

/// Owns the Automerge documents in SQLite. Every write goes through here, so
/// the read model, the conflict list and the sync flag always move together
/// with the document, in one transaction.
class DocStore extends ChangeNotifier {
  DocStore(this.db, this.profile);

  final Database db;
  final DeviceProfile profile;

  /// Bumped after every committed write; screens listen to reload.
  int revision = 0;

  /// Emits the patient id after each local edit, so sync can follow it.
  final localEdits = StreamController<String>.broadcast();

  Future<void> _lock = Future.value();

  /// Runs [task] after every earlier write has finished. Documents carry this
  /// device's actor id, so two overlapping edits of one document would reuse
  /// a sequence number and corrupt it.
  Future<T> _exclusive<T>(Future<T> Function() task) {
    final result = _lock.then((_) => task());
    _lock = result.then((_) {}, onError: (_) {});
    return result;
  }

  String _message(String kind, String summary) => ChangeMessage(
    deviceId: profile.deviceId,
    deviceName: profile.deviceName,
    kind: kind,
    summary: summary,
  ).encode();

  static int _now() => DateTime.now().millisecondsSinceEpoch ~/ 1000;

  Future<void> create(
    String id,
    List<DocField> patient, {
    required String kind,
    required String summary,
  }) => _exclusive(() async {
    final doc = PatientDoc.create(
      actorHex: profile.actorHex,
      patient: patient,
      message: _message(kind, summary),
      timeSecs: _now(),
    );
    await db.transaction((txn) async {
      if ((await txn.query(
        'docs',
        where: 'id = ?',
        whereArgs: [id],
      )).isNotEmpty) {
        throw StateError('A patient with this id already exists.');
      }
      await _write(txn, id, doc);
      await _markDirty(txn, id);
    });
    _committed(id);
  });

  /// Writes [fields] at [path] (`["patient"]` or `["visits", id]`). Returns
  /// false, and records nothing, when every value was already stored.
  Future<bool> change(
    String id,
    List<String> path,
    List<DocField> fields, {
    bool createVisit = false,
    required String kind,
    required String summary,
  }) => _exclusive(() async {
    var changed = false;
    await db.transaction((txn) async {
      final doc = await _load(txn, id);
      if (doc == null) throw StateError('Patient not found.');
      changed = doc.update(
        path: path,
        fields: fields,
        createVisit: createVisit,
        message: _message(kind, summary),
        timeSecs: _now(),
      );
      if (!changed) return;
      await _write(txn, id, doc);
      await _markDirty(txn, id);
    });
    if (changed) _committed(id);
    return changed;
  });

  /// Copies for a sync session. Unknown ids start blank and are filled by the
  /// server.
  Future<Map<String, PatientDoc>> loadForSync(Iterable<String> ids) async {
    final out = <String, PatientDoc>{};
    for (final id in ids) {
      out[id] =
          await _load(db, id) ?? PatientDoc.empty(actorHex: profile.actorHex);
    }
    return out;
  }

  /// Stores a document that came back from sync, merged with whatever is
  /// stored now so edits made while the sync ran are kept.
  Future<MergeResult> mergeRemote(
    String id,
    PatientDoc remote,
    List<String> headsBefore,
  ) => _exclusive(() async {
    final incoming = remote.changesSince(heads: headsBefore);
    final names = {
      for (final c in incoming)
        if (c.actor != profile.actorHex)
          ChangeMessage.parse(c.message).deviceName ?? 'the server',
    };
    var wrote = false;
    await db.transaction((txn) async {
      final stored = await _load(txn, id);
      final PatientDoc merged;
      if (stored == null) {
        if (remote.heads().isEmpty) return;
        merged = remote;
      } else {
        final before = stored.heads().join(',');
        stored.merge(other: remote);
        if (stored.heads().join(',') == before) return;
        merged = stored;
      }
      await _write(txn, id, merged);
      wrote = true;
    });
    if (wrote) {
      revision++;
      notifyListeners();
    }
    return MergeResult(
      received: incoming.where((c) => c.actor != profile.actorHex).length,
      fromDevices: names,
    );
  });

  /// Rebuilds every patient's rows from its document once, after a schema
  /// upgrade added a projected field (see [AppDatabase.reprojectKey]).
  Future<void> reprojectIfNeeded() => _exclusive(() async {
    var ran = false;
    await db.transaction((txn) async {
      final flag = await txn.query(
        'meta',
        where: 'key = ?',
        whereArgs: [AppDatabase.reprojectKey],
      );
      if (flag.isEmpty) return;
      for (final r in await txn.query('docs', columns: ['id', 'bytes'])) {
        final doc = PatientDoc.load(
          bytes: r['bytes'] as Uint8List,
          actorHex: profile.actorHex,
        );
        await _write(txn, r['id'] as String, doc);
      }
      await txn.delete(
        'meta',
        where: 'key = ?',
        whereArgs: [AppDatabase.reprojectKey],
      );
      ran = true;
    });
    if (ran) touch();
  });

  /// Local changes the server has not received, oldest first.
  Future<List<PendingChange>> pendingChanges() async {
    final rows = await db.rawQuery(
      'SELECT d.id, d.bytes, d.synced_heads FROM docs d JOIN dirty USING (id)',
    );
    final out = <PendingChange>[];
    for (final r in rows) {
      final doc = PatientDoc.load(
        bytes: r['bytes'] as Uint8List,
        actorHex: profile.actorHex,
      );
      final synced = _splitHeads(r['synced_heads'] as String);
      for (final c in doc.changesSince(heads: synced)) {
        if (c.actor != profile.actorHex) continue;
        final m = ChangeMessage.parse(c.message);
        out.add(
          PendingChange(
            patientId: r['id'] as String,
            verb: PendingChange.verbFor(m.kind),
            summary: m.summary ?? 'Change',
            time: DateTime.fromMillisecondsSinceEpoch(
              c.timeSecs.toInt() * 1000,
            ),
          ),
        );
      }
    }
    out.sort((a, b) => a.time.compareTo(b.time));
    return out;
  }

  /// Records that the server has everything up to [heads] for [id].
  Future<void> markSynced(Transaction txn, String id, List<String> heads) =>
      txn.update(
        'docs',
        {'synced_heads': heads.join(',')},
        where: 'id = ?',
        whereArgs: [id],
      );

  /// Tells listeners that tables outside the documents changed.
  void touch() {
    revision++;
    notifyListeners();
  }

  void _committed(String id) {
    revision++;
    notifyListeners();
    localEdits.add(id);
  }

  Future<PatientDoc?> _load(DatabaseExecutor ex, String id) async {
    final rows = await ex.query(
      'docs',
      columns: ['bytes'],
      where: 'id = ?',
      whereArgs: [id],
    );
    if (rows.isEmpty) return null;
    return PatientDoc.load(
      bytes: rows.first['bytes'] as Uint8List,
      actorHex: profile.actorHex,
    );
  }

  Future<void> _markDirty(Transaction txn, String id) => txn.insert('dirty', {
    'id': id,
    // Replaced on every edit, so a sync only clears the flag if nothing
    // changed while it ran.
    'token': const Uuid().v4(),
  }, conflictAlgorithm: ConflictAlgorithm.replace);

  Future<void> _write(Transaction txn, String id, PatientDoc doc) async {
    // Update rather than replace, so synced_heads survives.
    final row = {'bytes': doc.save(), 'heads': doc.heads().join(',')};
    final updated = await txn.update(
      'docs',
      row,
      where: 'id = ?',
      whereArgs: [id],
    );
    if (updated == 0) await txn.insert('docs', {'id': id, ...row});
    await txn.delete('visits', where: 'patient_id = ?', whereArgs: [id]);
    await txn.delete('replaced', where: 'patient_id = ?', whereArgs: [id]);

    final json = jsonDecode(doc.toJson()) as Map<String, dynamic>;
    final p = json['patient'];
    if (p is! Map) return; // Not downloaded yet.
    String s(Map m, String k) => switch (m[k]) {
      final String v => v,
      null => '',
      final v => '$v',
    };
    final mergedInto = s(p, 'merged_into');
    await txn.insert('patients', {
      'id': id,
      'name': s(p, 'name'),
      'phone': s(p, 'phone'),
      'status': s(p, 'status'),
      'location': s(p, 'location'),
      'head_of_household':
          (p['head_of_household'] == true || p['head_of_household'] == 'true')
          ? 1
          : 0,
      'registered_at': s(p, 'registered_at'),
      'merged_into': mergedInto,
    }, conflictAlgorithm: ConflictAlgorithm.replace);

    final visits = json['visits'];
    if (visits is Map) {
      // The server copies a duplicate's visits, same ids, into the patient it
      // was merged into. The merged copy never takes a row from that patient.
      final ownRows = mergedInto.isEmpty
          ? ConflictAlgorithm.replace
          : ConflictAlgorithm.ignore;
      final batch = txn.batch();
      for (final MapEntry(key: visitId, value: v) in visits.entries) {
        if (v is! Map) continue;
        batch.insert('visits', {
          'id': visitId,
          'patient_id': id,
          'visit_type': s(v, 'visit_type'),
          'timestamp': s(v, 'timestamp'),
          'reason': s(v, 'reason'),
          for (final f in vitalFields) f.key: s(v, f.key),
          'deleted_at': s(v, 'deleted_at'),
        }, conflictAlgorithm: ownRows);
      }
      await batch.commit(noResult: true);
    }

    final conflicts = doc.conflicts();
    final mine = profile.actorHex;
    final lost = conflicts.where(
      (c) => c.winner.actor != mine && c.others.any((o) => o.actor == mine),
    );
    if (lost.isEmpty) return;
    final names = <String, String>{};
    for (final c in doc.changesSince(heads: const [])) {
      final name = ChangeMessage.parse(c.message).deviceName;
      if (name != null) names[c.actor] = name;
    }
    for (final c in lost) {
      await txn.insert('replaced', {
        'patient_id': id,
        'path': c.path.join('/'),
        'key': c.key,
        'mine': c.others.lastWhere((o) => o.actor == mine).value,
        'kept': c.winner.value,
        'kept_by': names[c.winner.actor] ?? 'the server',
      }, conflictAlgorithm: ConflictAlgorithm.replace);
    }
  }

  static List<String> _splitHeads(String joined) =>
      joined.isEmpty ? const [] : joined.split(',');

  @override
  void dispose() {
    localEdits.close();
    super.dispose();
  }
}
