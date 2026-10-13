import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:sqflite/sqflite.dart';

import '../src/rust/api/doc.dart';
import 'doc_store.dart';
import 'sync_api.dart';

/// What the status pill shows: whether the phone has internet, or that a sync
/// is running.
enum Connection { online, offline, syncing }

/// The server's per-request limit (MAX_DOCS_PER_REQUEST).
const _batch = 500;

/// A sync normally settles in 2 to 4 rounds; never loop forever.
const _maxRounds = 20;

/// Syncs patient documents with the HMIS server using the Automerge sync
/// protocol, following HMIS/benchmarks/client/device.mjs and HMISWeb's
/// SyncService. Screens never wait on this: they read and write SQLite, and
/// sync runs in the background whenever the server is reachable.
class SyncService extends ChangeNotifier {
  SyncService({
    required this.store,
    required this.api,
    this.interval = const Duration(seconds: 60),
    this.debounce = const Duration(seconds: 2),
    this.retryDelays = const [
      Duration(seconds: 2),
      Duration(seconds: 5),
      Duration(seconds: 15),
      Duration(seconds: 30),
    ],
    this.checkOnline = const Duration(seconds: 15),
    this.checkOffline = const Duration(seconds: 3),
  });

  final DocStore store;

  /// Called per run, so a changed server URL applies on the next sync.
  final SyncApi Function() api;
  final Duration interval;
  final Duration debounce;

  /// Waits before retrying after each consecutive failure; the last one
  /// repeats, capped at [interval]. A network that has just come back usually
  /// needs a few seconds before requests get through.
  final List<Duration> retryDelays;

  /// How often to confirm the connection while online, and to look for it
  /// again while offline.
  final Duration checkOnline;
  final Duration checkOffline;
  Database get _db => store.db;

  /// Offline until a request reaches the server.
  Connection get connection => !_online
      ? Connection.offline
      : _syncing
      ? Connection.syncing
      : Connection.online;
  bool _online = false;
  bool _syncing = false;
  DateTime? lastSyncedAt;
  String? lastError;

  /// While syncing: documents settled so far, out of [progressTotal].
  int progressDone = 0;
  int progressTotal = 0;

  /// While syncing: local changes being sent.
  int sending = 0;

  Future<void>? _running;
  bool _rerun = false;
  bool _networkUp = true;
  Timer? _timer;
  Timer? _debounceTimer;
  Timer? _retryTimer;
  Timer? _checkTimer;

  /// Failed syncs in a row, which sets how long to wait before the next retry.
  int _failures = 0;
  bool _started = false;
  bool _disposed = false;
  StreamSubscription<String>? _edits;
  StreamSubscription<bool>? _network;

  /// Wires the background triggers. Call once at app start.
  /// [networkChanges] emits false when the phone loses its network. Having a
  /// network is not the same as having internet (wifi without internet, a
  /// hotspot login page), so a short request to the server confirms it.
  Future<void> start({Stream<bool>? networkChanges}) async {
    final row = await _db.query(
      'meta',
      where: 'key = ?',
      whereArgs: ['last_synced_at'],
    );
    if (row.isNotEmpty) {
      lastSyncedAt = DateTime.tryParse(row.first['value'] as String)?.toLocal();
    }
    _started = true;
    _edits = store.localEdits.stream.listen((_) => schedule());
    _network = networkChanges?.listen((up) {
      _networkUp = up;
      if (up) {
        unawaited(check());
      } else {
        _setOnline(false);
      }
    });
    _timer = Timer.periodic(interval, (_) => syncNow());
    // Syncs once the server answers.
    unawaited(check());
  }

  /// Checks the connection now, and again later while started.
  Future<void> check() async {
    _checkTimer?.cancel();
    var reachable = false;
    if (_networkUp) {
      final api = this.api();
      try {
        reachable = await api.reachable();
      } finally {
        api.close();
      }
    }
    _setOnline(reachable);
    _scheduleCheck();
  }

  void _scheduleCheck() {
    if (!_started) return;
    _checkTimer?.cancel();
    _checkTimer = Timer(_online ? checkOnline : checkOffline, check);
  }

  void _setOnline(bool online) {
    if (_disposed) return;
    final back = online && !_online;
    _online = online;
    notifyListeners();
    // A running sync that reached the server needs no second one.
    if (back && _running == null) {
      _failures = 0;
      unawaited(syncNow());
    }
  }

  /// Syncs shortly after a local edit, so a burst of edits goes in one sync.
  void schedule() {
    _debounceTimer?.cancel();
    _debounceTimer = Timer(debounce, syncNow);
  }

  /// Runs a sync now, or once more after the current one finishes.
  Future<void> syncNow() {
    if (!_networkUp) return Future.value();
    if (_running != null) {
      _rerun = true;
      return _running!;
    }
    _retryTimer?.cancel();
    final run = _run().whenComplete(() {
      _running = null;
      if (_rerun) {
        _rerun = false;
        unawaited(syncNow());
      }
    });
    _running = run;
    return run;
  }

  Future<void> _run() async {
    final api = this.api();
    try {
      // Snapshot the flags before reading any doc: an edit after this point
      // gets a new token and stays flagged, so it goes out on the next sync.
      final dirty = {
        for (final r in await _db.query('dirty'))
          r['id'] as String: r['token'] as String,
      };
      final pending = await store.pendingChanges();
      final since = await _meta('since');
      final manifest = await api.manifest(since);
      _setOnline(true);

      final ids = {...dirty.keys};
      final stored = {
        for (final r in await _db.query('docs', columns: ['id', 'heads']))
          r['id'] as String: r['heads'] as String,
      };
      manifest.docs.forEach((id, heads) {
        if (stored[id] != ([...heads]..sort()).join(',')) ids.add(id);
      });

      final now = DateTime.now();
      if (ids.isEmpty) {
        await _finish(manifest.serverTime, now);
        return;
      }

      sending = pending.length;
      progressTotal = ids.length;
      progressDone = 0;
      _syncing = true;
      notifyListeners();

      final docs = await store.loadForSync(ids);
      final headsBefore = {
        for (final MapEntry(:key, :value) in docs.entries) key: value.heads(),
      };
      final problems = await _exchange(api, docs);

      var received = 0;
      final merged = <String, MergeResult>{};
      for (final MapEntry(key: id, value: doc) in docs.entries) {
        final result = await store.mergeRemote(id, doc, headsBefore[id]!);
        received += result.received;
        // Both sides changed this patient: tell the user the edits merged.
        if (dirty.containsKey(id) && result.received > 0) merged[id] = result;
      }

      final notices = await _mergeNotices(merged);
      await _db.transaction((txn) async {
        for (final MapEntry(key: id, value: token) in dirty.entries) {
          await txn.delete(
            'dirty',
            where: 'id = ? AND token = ?',
            whereArgs: [id, token],
          );
        }
        for (final MapEntry(key: id, value: doc) in docs.entries) {
          await store.markSynced(txn, id, doc.heads());
          await txn.delete('problems', where: 'id = ?', whereArgs: [id]);
        }
        for (final MapEntry(key: id, value: messages) in problems.entries) {
          await txn.insert('problems', {
            'id': id,
            'messages': jsonEncode(messages),
          }, conflictAlgorithm: ConflictAlgorithm.replace);
        }
        for (final n in notices) {
          await txn.insert('notices', n.row);
        }
        if (pending.isNotEmpty || received > 0 || notices.isNotEmpty) {
          await txn.insert('sync_runs', {
            'finished_at': now.toUtc().toIso8601String(),
            'outcome': notices.isEmpty ? 'done' : 'merged',
            'sent': pending.length,
            'received': received,
            'detail': notices.isEmpty
                ? _counts(pending.length, received)
                : notices.map((n) => n.summary).join('; '),
          });
        }
      });
      await _finish(manifest.serverTime, now);
    } on Object catch (e) {
      lastError = e is SyncHttpException ? e.message : 'Sync failed: $e';
      await _recordFailure(lastError!);
      _syncing = false;
      if (e is SyncHttpException && e.unreachable) {
        _setOnline(false);
        _scheduleCheck();
      } else {
        notifyListeners();
      }
      _retrySoon();
    } finally {
      sending = 0;
      progressTotal = 0;
      api.close();
      store.touch();
    }
  }

  /// Runs sync rounds until no document has anything left to send. Returns
  /// the server's problems per document.
  Future<Map<String, List<String>>> _exchange(
    SyncApi api,
    Map<String, PatientDoc> docs,
  ) async {
    final lastSent = <String, String>{};
    final problems = <String, List<String>>{};
    var pending = docs.keys.toList();

    for (var round = 1; pending.isNotEmpty; round++) {
      if (round > _maxRounds) {
        throw StateError(
          'Sync did not settle after $_maxRounds rounds '
          '(${pending.length} records).',
        );
      }
      final outgoing = <String, String>{};
      for (final id in pending) {
        final doc = docs[id]!;
        var msg = doc.generateSyncMessage();
        var encoded = msg == null ? null : base64Encode(msg);
        // The server reloads each doc per request, so changes it had to
        // queue (a dependency was missing) are dropped while this side has
        // marked them as sent. That shows up as the same message repeating:
        // reset the sync state so everything the server lacks is offered again.
        if (encoded != null && lastSent[id] == encoded) {
          doc.resetSyncState();
          msg = doc.generateSyncMessage();
          encoded = msg == null ? null : base64Encode(msg);
        }
        if (encoded != null) outgoing[id] = lastSent[id] = encoded;
      }

      final keys = outgoing.keys.toList();
      progressDone = progressTotal - keys.length;
      notifyListeners();
      if (keys.isEmpty) break;
      for (var i = 0; i < keys.length; i += _batch) {
        final batch = {
          for (final k in keys.skip(i).take(_batch)) k: outgoing[k]!,
        };
        final reply = await api.exchange(batch);
        problems.addAll(reply.problems);
        for (final MapEntry(key: id, value: b64) in reply.docs.entries) {
          final doc = docs[id];
          if (b64 == null || doc == null) continue;
          doc.receiveSyncMessage(message: base64Decode(b64));
        }
      }
      pending = keys;
    }
    return problems;
  }

  Future<List<({Map<String, Object?> row, String summary})>> _mergeNotices(
    Map<String, MergeResult> merged,
  ) async {
    final out = <({Map<String, Object?> row, String summary})>[];
    final now = DateTime.now().toUtc().toIso8601String();
    for (final MapEntry(key: id, value: result) in merged.entries) {
      // A replaced edit gets its own banner instead.
      final replaced = await _db.query(
        'replaced',
        where: 'patient_id = ?',
        whereArgs: [id],
      );
      if (replaced.isNotEmpty) continue;
      final rows = await _db.query(
        'patients',
        columns: ['name'],
        where: 'id = ?',
        whereArgs: [id],
      );
      final name = rows.isEmpty ? 'A patient' : rows.first['name'] as String;
      final from = result.fromDevices.length == 1
          ? result.fromDevices.first
          : 'other devices';
      out.add((
        row: {
          'patient_id': id,
          'title': 'Merged a change from $from',
          'body': "$name's record now has both edits.",
          'created_at': now,
        },
        summary: '$name: edits merged',
      ));
    }
    return out;
  }

  Future<void> _finish(String serverTime, DateTime now) async {
    final batch = _db.batch()
      ..insert('meta', {
        'key': 'since',
        'value': serverTime,
      }, conflictAlgorithm: ConflictAlgorithm.replace)
      ..insert('meta', {
        'key': 'last_synced_at',
        'value': now.toUtc().toIso8601String(),
      }, conflictAlgorithm: ConflictAlgorithm.replace);
    await batch.commit(noResult: true);
    lastSyncedAt = now;
    lastError = null;
    _failures = 0;
    _syncing = false;
    notifyListeners();
  }

  /// Retries a failed sync with backoff, instead of waiting out [interval].
  void _retrySoon() {
    if (!_started || retryDelays.isEmpty) return;
    final delay = retryDelays[_failures.clamp(0, retryDelays.length - 1)];
    _failures++;
    _retryTimer?.cancel();
    _retryTimer = Timer(delay < interval ? delay : interval, syncNow);
  }

  /// Offline phones retry every minute; keep one history line per outage.
  Future<void> _recordFailure(String detail) async {
    final last = await _db.query('sync_runs', orderBy: 'id DESC', limit: 1);
    final now = DateTime.now().toUtc().toIso8601String();
    if (last.isNotEmpty && last.first['outcome'] == 'failed') {
      await _db.update(
        'sync_runs',
        {'finished_at': now, 'detail': detail},
        where: 'id = ?',
        whereArgs: [last.first['id']],
      );
    } else {
      await _db.insert('sync_runs', {
        'finished_at': now,
        'outcome': 'failed',
        'sent': 0,
        'received': 0,
        'detail': detail,
      });
    }
  }

  Future<String?> _meta(String key) async {
    final rows = await _db.query('meta', where: 'key = ?', whereArgs: [key]);
    return rows.isEmpty ? null : rows.first['value'] as String;
  }

  static String _counts(int sent, int received) {
    String n(int count, String verb) =>
        '$count ${count == 1 ? 'change' : 'changes'} $verb';
    return [
      if (sent > 0) n(sent, 'sent'),
      if (received > 0) n(received, 'received'),
    ].join(', ');
  }

  @override
  void dispose() {
    _timer?.cancel();
    _debounceTimer?.cancel();
    _retryTimer?.cancel();
    _checkTimer?.cancel();
    _started = false;
    _disposed = true;
    _edits?.cancel();
    _network?.cancel();
    super.dispose();
  }
}
