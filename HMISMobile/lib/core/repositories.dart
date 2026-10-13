import 'dart:convert';

import 'package:sqflite/sqflite.dart';
import 'package:uuid/uuid.dart';

import 'doc_store.dart';
import 'identity.dart';
import 'models.dart';
import 'schema.dart';

class PatientInput {
  const PatientInput({
    required this.name,
    required this.phone,
    required this.status,
    required this.location,
    required this.headOfHousehold,
  });

  final String name;
  final String phone;
  final String status;
  final String location;
  final bool headOfHousehold;

  List<DocField> toFields() => [
    textField('name', name.trim()),
    textField('phone', normalizePhone(phone)),
    textField('status', status),
    textField('location', location.trim()),
    flagField('head_of_household', headOfHousehold),
  ];
}

/// Reads come from the projected tables. Writes edit the patient's document.
/// There is no delete: the server keeps every record, so set the status to
/// inactive instead.
///
/// The server merges a duplicate registration into the older record and marks
/// the duplicate with merged_into. Lists leave merged patients out; [get]
/// still returns them, and [canonical] finds the record they were merged into.
class PatientRepository {
  PatientRepository(this.store);

  final DocStore store;
  Database get _db => store.db;

  Future<List<Patient>> all({String search = ''}) async {
    final term = search.trim();
    // Phones are stored as +254..., so a typed local number also matches
    // without its leading 0.
    final local = term
        .replaceAll(RegExp(r'[\s\-().+]'), '')
        .replaceFirst(RegExp('^0+'), '');
    final phoneTerm = RegExp(r'^[0-9]+$').hasMatch(local) ? local : term;
    final rows = term.isEmpty
        ? await _db.query(
            'patients',
            where: "merged_into = ''",
            orderBy: 'name COLLATE NOCASE',
          )
        : await _db.query(
            'patients',
            where:
                "merged_into = '' AND (name LIKE ? OR phone LIKE ? "
                'OR phone LIKE ? OR location LIKE ?)',
            whereArgs: ['%$term%', '%$term%', '%$phoneTerm%', '%$term%'],
            orderBy: 'name COLLATE NOCASE',
          );
    return rows.map(Patient.fromRow).toList();
  }

  Future<Patient?> get(String id) => _get(_db, id);

  /// The record [id] lives on as: itself, or the patient it was merged into,
  /// following the chain. Stops early at a patient that has not downloaded
  /// yet or at a cycle, so the result can still be merged.
  Future<Patient?> canonical(String id) => _canonical(_db, id);

  /// Unmerged patients on this phone whose phone normalises to the same
  /// number as [phone]; empty when [phone] is blank.
  Future<List<Patient>> withPhone(String phone) async {
    final number = normalizePhone(phone);
    if (number.isEmpty) return const [];
    final rows = await _db.query(
      'patients',
      where: "merged_into = '' AND phone != ''",
      orderBy: 'name COLLATE NOCASE',
    );
    return [
      for (final p in rows.map(Patient.fromRow))
        if (normalizePhone(p.phone) == number) p,
    ];
  }

  Future<String> create(PatientInput input) async {
    final id = const Uuid().v4();
    await store.create(
      id,
      [
        ...input.toFields(),
        textField('registered_at', DateTime.now().toUtc().toIso8601String()),
      ],
      kind: 'patient.create',
      summary:
          '${input.headOfHousehold ? 'Household' : 'Patient'}: ${input.name.trim()}',
    );
    return id;
  }

  /// Only fields that changed are written, so concurrent edits to other
  /// fields on other devices survive.
  Future<void> update(String id, PatientInput input) => store.change(
    id,
    const ['patient'],
    input.toFields(),
    kind: 'patient.update',
    summary: 'Patient: ${input.name.trim()}',
  );

  /// Values the server could not save for this patient.
  Future<List<String>> problems(String id) async {
    final rows = await _db.query('problems', where: 'id = ?', whereArgs: [id]);
    if (rows.isEmpty) return const [];
    return (jsonDecode(rows.first['messages'] as String) as List)
        .cast<String>();
  }

  /// Patients with local changes the server has not received.
  Future<Set<String>> pendingIds() async {
    final rows = await _db.query('dirty', columns: ['id']);
    return {for (final r in rows) r['id'] as String};
  }
}

class VisitInput {
  const VisitInput({
    required this.visitType,
    required this.time,
    required this.reason,
    required this.vitals,
  });

  final String visitType;
  final DateTime time;
  final String reason;

  /// Vital key to value; '' when not recorded.
  final Map<String, String> vitals;

  List<DocField> toFields() => [
    textField('visit_type', visitType),
    textField('timestamp', time.toUtc().toIso8601String()),
    textField('reason', reason.trim()),
    for (final f in vitalFields) textField(f.key, vitals[f.key]?.trim() ?? ''),
  ];
}

/// Visits live inside their patient's document, so they cannot move between
/// patients. Deleting sets deleted_at; the visit stays in the document.
class VisitRepository {
  VisitRepository(this.store);

  final DocStore store;
  Database get _db => store.db;

  static const _select = '''
    SELECT v.*, p.name AS patient_name
    FROM visits v LEFT JOIN patients p ON p.id = v.patient_id
  ''';

  /// Visits on the local calendar day of [day], oldest first.
  Future<List<Visit>> onDay(DateTime day) async {
    final start = DateTime(day.year, day.month, day.day);
    final end = start.add(const Duration(days: 1));
    // Stored timestamps can carry any offset, so fetch a day either side by
    // string and filter exactly on the parsed time.
    final rows = await _db.rawQuery(
      "$_select WHERE v.deleted_at = '' AND v.timestamp >= ? AND v.timestamp < ? "
      'ORDER BY v.timestamp',
      [
        start.subtract(const Duration(days: 1)).toUtc().toIso8601String(),
        end.add(const Duration(days: 1)).toUtc().toIso8601String(),
      ],
    );
    final visits = rows.map(Visit.fromRow).where((v) {
      final t = v.time;
      return t != null && !t.isBefore(start) && t.isBefore(end);
    }).toList();
    visits.sort((a, b) => a.time!.compareTo(b.time!));
    return visits;
  }

  /// Every visit that is not deleted, newest first.
  Future<List<Visit>> all() async {
    final rows = await _db.rawQuery(
      "$_select WHERE v.deleted_at = '' ORDER BY v.timestamp DESC",
    );
    return rows.map(Visit.fromRow).toList();
  }

  /// Includes visits still only in duplicates merged into [patientId]; the
  /// server copies them across on a later sync.
  Future<List<Visit>> forPatient(
    String patientId, {
    bool includeDeleted = false,
  }) async {
    final rows = await _db.rawQuery(
      'WITH RECURSIVE merged(id) AS ('
      '  SELECT ? UNION SELECT p.id FROM patients p JOIN merged m'
      '  ON p.merged_into = m.id'
      ') '
      '$_select WHERE v.patient_id IN (SELECT id FROM merged) '
      "${includeDeleted ? '' : "AND v.deleted_at = '' "}"
      'ORDER BY v.timestamp DESC',
      [patientId],
    );
    return rows.map(Visit.fromRow).toList();
  }

  Future<Visit?> get(String id) async {
    final rows = await _db.rawQuery('$_select WHERE v.id = ?', [id]);
    return rows.isEmpty ? null : Visit.fromRow(rows.first);
  }

  /// A visit for a merged patient goes into the patient it was merged into,
  /// or stays in the duplicate if that one has not downloaded yet.
  Future<String> create(String patientId, VisitInput input) async {
    final id = const Uuid().v4();
    final target = (await _canonical(_db, patientId))?.id ?? patientId;
    final name = await _patientName(target);
    await store.change(
      target,
      ['visits', id],
      [...input.toFields(), textField('deleted_at', '')],
      createVisit: true,
      kind: 'visit.create',
      summary: 'Visit: $name',
    );
    return id;
  }

  Future<void> update(Visit visit, VisitInput input) async {
    final name = await _patientName(visit.patientId);
    final onlyVitals =
        input.visitType == visit.visitType &&
        input.time.toUtc().toIso8601String() == visit.timestamp &&
        input.reason.trim() == visit.reason;
    await store.change(
      visit.patientId,
      ['visits', visit.id],
      input.toFields(),
      kind: onlyVitals ? 'visit.vitals' : 'visit.update',
      summary: '${onlyVitals ? 'Vitals' : 'Visit'}: $name',
    );
  }

  Future<void> delete(Visit visit) async {
    final name = await _patientName(visit.patientId);
    await store.change(
      visit.patientId,
      ['visits', visit.id],
      [textField('deleted_at', DateTime.now().toUtc().toIso8601String())],
      kind: 'visit.delete',
      summary: '${visit.reason.isEmpty ? 'Visit' : visit.reason}: $name',
    );
  }

  Future<void> restore(Visit visit) async {
    final name = await _patientName(visit.patientId);
    await store.change(
      visit.patientId,
      ['visits', visit.id],
      [textField('deleted_at', '')],
      kind: 'visit.restore',
      summary: 'Visit: $name',
    );
  }

  Future<String> _patientName(String patientId) async {
    final rows = await _db.query(
      'patients',
      columns: ['name'],
      where: 'id = ?',
      whereArgs: [patientId],
    );
    return rows.isEmpty ? 'patient' : rows.first['name'] as String;
  }
}

/// Banners and history that come out of syncing.
class ActivityRepository {
  ActivityRepository(this.store);

  final DocStore store;
  Database get _db => store.db;

  Future<List<ReplacedEdit>> replacedEdits() async {
    final rows = await _db.rawQuery('''
      SELECT r.*, p.name AS patient_name
      FROM replaced r LEFT JOIN patients p ON p.id = r.patient_id
      ORDER BY p.name
    ''');
    return rows.map(ReplacedEdit.fromRow).toList();
  }

  /// Re-enter mine, or keep the value that won. Either way the field gets a
  /// fresh write, which ends the conflict on every device once it syncs.
  Future<void> resolve(ReplacedEdit edit, {required bool keepMine}) {
    final value = keepMine ? edit.mine : edit.kept;
    return store.change(
      edit.patientId,
      edit.path,
      [
        edit.key == 'head_of_household'
            ? flagField(edit.key, value == 'true')
            : textField(edit.key, value),
      ],
      kind: 'conflict.resolve',
      summary: '${_capitalise(fieldLabel(edit.key))}: ${edit.patientName}',
    );
  }

  Future<List<MergeNotice>> notices() async {
    final rows = await _db.query(
      'notices',
      where: 'dismissed = 0',
      orderBy: 'id DESC',
    );
    return [
      for (final r in rows)
        MergeNotice(
          id: r['id'] as int,
          title: r['title'] as String,
          body: r['body'] as String,
        ),
    ];
  }

  Future<void> dismissNotice(int id) async {
    await _db.update(
      'notices',
      {'dismissed': 1},
      where: 'id = ?',
      whereArgs: [id],
    );
    store.touch();
  }

  Future<List<SyncRun>> runs({int limit = 50}) async {
    final rows = await _db.query('sync_runs', orderBy: 'id DESC', limit: limit);
    return rows.map(SyncRun.fromRow).toList();
  }

  Future<Map<SyncOutcome, int>> runCounts() async {
    final rows = await _db.rawQuery(
      'SELECT outcome, COUNT(*) AS n FROM sync_runs GROUP BY outcome',
    );
    return {
      for (final r in rows)
        SyncOutcome.values.byName(r['outcome'] as String): r['n'] as int,
    };
  }

  Future<int> problemCount() async =>
      Sqflite.firstIntValue(
        await _db.rawQuery('SELECT COUNT(*) FROM problems'),
      ) ??
      0;
}

Future<Patient?> _get(DatabaseExecutor db, String id) async {
  final rows = await db.query('patients', where: 'id = ?', whereArgs: [id]);
  return rows.isEmpty ? null : Patient.fromRow(rows.first);
}

Future<Patient?> _canonical(DatabaseExecutor db, String id) async {
  var patient = await _get(db, id);
  final seen = {id};
  while (patient != null && patient.isMerged && seen.add(patient.mergedInto)) {
    final next = await _get(db, patient.mergedInto);
    if (next == null) break;
    patient = next;
  }
  return patient;
}

String _capitalise(String s) =>
    s.isEmpty ? s : '${s[0].toUpperCase()}${s.substring(1)}';
