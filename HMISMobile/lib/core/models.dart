import 'dart:convert';

import 'schema.dart';

/// Read model, projected from the patient's Automerge document. Never written
/// directly: edits go through [DocStore].
class Patient {
  const Patient({
    required this.id,
    required this.name,
    required this.phone,
    required this.status,
    required this.location,
    required this.headOfHousehold,
    required this.registeredAt,
    required this.mergedInto,
  });

  /// Patient UUID; also the document id.
  final String id;
  final String name;
  final String phone;

  /// Raw stored value; may fall outside [PatientStatus] (see [statusLabel]).
  final String status;
  final String location;
  final bool headOfHousehold;
  final String registeredAt;

  /// Id of the patient the server merged this duplicate into; '' when not
  /// merged. Written only by the server.
  final String mergedInto;

  bool get isMerged => mergedInto.isNotEmpty;

  String get statusLabel => PatientStatus.tryParse(status)?.label ?? status;

  factory Patient.fromRow(Map<String, Object?> r) => Patient(
    id: r['id'] as String,
    name: r['name'] as String,
    phone: r['phone'] as String,
    status: r['status'] as String,
    location: r['location'] as String,
    headOfHousehold: r['head_of_household'] == 1,
    registeredAt: r['registered_at'] as String,
    mergedInto: r['merged_into'] as String,
  );
}

class Visit {
  const Visit({
    required this.id,
    required this.patientId,
    required this.visitType,
    required this.timestamp,
    required this.reason,
    required this.vitals,
    required this.deletedAt,
    this.patientName,
  });

  /// Visit UUID; the key in the document's visits map.
  final String id;
  final String patientId;
  final String visitType;

  /// ISO-8601 as stored; may be unparseable if another device wrote junk.
  final String timestamp;
  final String reason;

  /// Vital key to decimal string; '' when not recorded.
  final Map<String, String> vitals;

  /// '' when not deleted.
  final String deletedAt;

  /// Joined from patients; null if the patient row is missing.
  final String? patientName;

  bool get isDeleted => deletedAt.isNotEmpty;
  DateTime? get time => DateTime.tryParse(timestamp)?.toLocal();
  String get typeLabel => VisitType.labelFor(visitType);

  /// What the visit was for: the reason if given, else the visit type.
  String get title => reason.isNotEmpty ? reason : typeLabel;

  bool get hasVitals => vitals.values.any((v) => v.isNotEmpty);

  factory Visit.fromRow(Map<String, Object?> r) => Visit(
    id: r['id'] as String,
    patientId: r['patient_id'] as String,
    visitType: r['visit_type'] as String,
    timestamp: r['timestamp'] as String,
    reason: r['reason'] as String,
    vitals: {for (final f in vitalFields) f.key: r[f.key] as String},
    deletedAt: r['deleted_at'] as String,
    patientName: r['patient_name'] as String?,
  );
}

/// What a commit message says about a change. See "Change messages" in
/// HMIS/DOCUMENT_SCHEMA.md.
class ChangeMessage {
  const ChangeMessage({
    this.deviceId,
    this.deviceName,
    this.kind,
    this.summary,
  });

  final String? deviceId;
  final String? deviceName;
  final String? kind;
  final String? summary;

  String encode() => jsonEncode({
    'device_id': deviceId,
    'device_name': deviceName,
    'kind': kind,
    'summary': summary,
  });

  /// Messages may be missing (server REST edits) or not JSON; never throws.
  static ChangeMessage parse(String? raw) {
    if (raw == null || raw.isEmpty) return const ChangeMessage();
    try {
      final j = jsonDecode(raw);
      if (j is! Map) return const ChangeMessage();
      String? s(String k) => j[k] is String ? j[k] as String : null;
      return ChangeMessage(
        deviceId: s('device_id'),
        deviceName: s('device_name'),
        kind: s('kind'),
        summary: s('summary'),
      );
    } on FormatException {
      return const ChangeMessage();
    }
  }
}

enum ChangeVerb { added, edited, deleted }

/// A local change the server has not received yet.
class PendingChange {
  const PendingChange({
    required this.patientId,
    required this.verb,
    required this.summary,
    required this.time,
  });

  final String patientId;
  final ChangeVerb verb;
  final String summary;
  final DateTime time;

  static ChangeVerb verbFor(String? kind) => switch (kind) {
    'patient.create' || 'visit.create' => ChangeVerb.added,
    'visit.delete' => ChangeVerb.deleted,
    _ => ChangeVerb.edited,
  };
}

/// A field where this device's edit lost to a concurrent edit elsewhere.
class ReplacedEdit {
  const ReplacedEdit({
    required this.patientId,
    required this.patientName,
    required this.path,
    required this.key,
    required this.mine,
    required this.kept,
    required this.keptBy,
  });

  final String patientId;
  final String patientName;

  /// ["patient"] or ["visits", id].
  final List<String> path;
  final String key;
  final String mine;
  final String kept;

  /// Device name that wrote [kept], or "the server".
  final String keptBy;

  factory ReplacedEdit.fromRow(Map<String, Object?> r) => ReplacedEdit(
    patientId: r['patient_id'] as String,
    patientName: r['patient_name'] as String? ?? 'A patient',
    path: (r['path'] as String).split('/'),
    key: r['key'] as String,
    mine: r['mine'] as String,
    kept: r['kept'] as String,
    keptBy: r['kept_by'] as String,
  );
}

/// "Merged a change from your tablet" banner.
class MergeNotice {
  const MergeNotice({
    required this.id,
    required this.title,
    required this.body,
  });

  final int id;
  final String title;
  final String body;
}

enum SyncOutcome { done, merged, failed }

class SyncRun {
  const SyncRun({
    required this.finishedAt,
    required this.outcome,
    required this.sent,
    required this.received,
    required this.detail,
  });

  final DateTime finishedAt;
  final SyncOutcome outcome;
  final int sent;
  final int received;
  final String detail;

  factory SyncRun.fromRow(Map<String, Object?> r) => SyncRun(
    finishedAt: DateTime.parse(r['finished_at'] as String).toLocal(),
    outcome: SyncOutcome.values.byName(r['outcome'] as String),
    sent: r['sent'] as int,
    received: r['received'] as int,
    detail: r['detail'] as String,
  );
}
