import 'dart:convert';
import 'dart:io';

import 'package:flutter_rust_bridge/flutter_rust_bridge_for_generated_io.dart';
import 'package:hmis_mobile/core/db.dart';
import 'package:hmis_mobile/core/device_profile.dart';
import 'package:hmis_mobile/core/doc_store.dart';
import 'package:hmis_mobile/core/repositories.dart';
import 'package:hmis_mobile/core/sync_api.dart';
import 'package:hmis_mobile/core/sync_service.dart';
import 'package:hmis_mobile/src/rust/api/doc.dart';
import 'package:hmis_mobile/src/rust/frb_generated.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

/// Loads the Rust library built for this machine by `cargo build` in rust/.
Future<void> initTestEnvironment() async {
  sqfliteFfiInit();
  databaseFactory = databaseFactoryFfi;
  final lib = File('rust/target/debug/librust_lib_hmis_mobile.so');
  if (!lib.existsSync()) {
    throw StateError('Run `cargo build` in rust/ before the Dart tests.');
  }
  await RustLib.init(externalLibrary: ExternalLibrary.open(lib.path));
}

/// One phone: its own database, document store and sync service.
class TestDevice {
  TestDevice._(this.store, this.sync, this._dir);

  final DocStore store;
  final SyncService sync;
  final Directory _dir;

  PatientRepository get patients => PatientRepository(store);
  VisitRepository get visits => VisitRepository(store);
  ActivityRepository get activity => ActivityRepository(store);

  /// [server] is called once per sync run, like the app's SyncApi factory.
  static Future<TestDevice> create(
    SyncApi Function() server, {
    String name = 'Phone',
  }) async {
    final dir = await Directory.systemTemp.createTemp('hmis_test_');
    final device = await _open(dir, server);
    await device.store.profile.save(
      workerName: 'Nurse',
      area: 'Kinangop',
      deviceName: name,
      serverUrl: 'http://fake',
    );
    return device;
  }

  /// Opens the database at [dir] the way the app starts up.
  static Future<TestDevice> _open(
    Directory dir,
    SyncApi Function() server,
  ) async {
    final db = await AppDatabase.open(path: dbPath(dir));
    final profile = await DeviceProfile.load(db);
    final store = DocStore(db, profile);
    await store.reprojectIfNeeded();
    final sync = SyncService(store: store, api: server);
    return TestDevice._(store, sync, dir);
  }

  static String dbPath(Directory dir) => '${dir.path}/db.sqlite';

  /// Closes the database, lets [beforeOpen] edit the file directly (e.g. to
  /// roll it back to an older schema), then restarts the app on it. Use the
  /// returned device from then on.
  Future<TestDevice> restart(
    SyncApi Function() server, {
    Future<void> Function(String path)? beforeOpen,
  }) async {
    sync.dispose();
    await store.db.close();
    await beforeOpen?.call(dbPath(_dir));
    return _open(_dir, server);
  }

  Future<void> close() async {
    sync.dispose();
    await store.db.close();
    await _dir.delete(recursive: true);
  }
}

/// In-memory stand-in for HMIS/patients/sync_views.py. Like the real server it
/// reloads each document per request and keeps no sync state between them.
class FakeServer extends SyncApi {
  FakeServer() : super('http://fake');

  final Map<String, List<int>> docs = {};
  bool down = false;

  /// Answers every sync request with an error, as a broken server would.
  bool refuse = false;
  int requests = 0;

  static const _actor = '00000000000000000000000000000001';

  @override
  Future<Manifest> manifest(String? since) async {
    _check();
    return Manifest(DateTime.now().toUtc().toIso8601String(), {
      for (final MapEntry(:key, :value) in docs.entries)
        key: PatientDoc.load(bytes: value, actorHex: _actor).heads(),
    });
  }

  @override
  Future<SyncReply> exchange(Map<String, String> batch) async {
    _check();
    final replies = <String, String?>{};
    for (final MapEntry(key: id, value: b64) in batch.entries) {
      final stored = docs[id];
      final doc = stored == null
          ? PatientDoc.empty(actorHex: _actor)
          : PatientDoc.load(bytes: stored, actorHex: _actor);
      doc.receiveSyncMessage(message: base64Decode(b64));
      final reply = doc.generateSyncMessage();
      if (doc.heads().isNotEmpty) docs[id] = doc.save();
      replies[id] = reply == null ? null : base64Encode(reply);
    }
    return SyncReply(replies, const {});
  }

  /// What HMIS/patients/duplicates.py does on finding [duplicateId] is the
  /// same person as [canonicalId]: copy its visits across and mark it.
  void merge(String duplicateId, String canonicalId) {
    final duplicate = PatientDoc.load(
      bytes: docs[duplicateId]!,
      actorHex: _actor,
    );
    final canonical = PatientDoc.load(
      bytes: docs[canonicalId]!,
      actorHex: _actor,
    );
    final visits = (state(duplicateId)['visits'] as Map).cast<String, Map>();
    for (final MapEntry(key: id, value: visit) in visits.entries) {
      canonical.update(
        path: ['visits', id],
        fields: [
          for (final MapEntry(:key, :value) in visit.entries)
            DocField(key: key as String, text: value as String),
        ],
        createVisit: true,
        message: '',
        timeSecs: 0,
      );
    }
    duplicate.update(
      path: const ['patient'],
      fields: [DocField(key: 'merged_into', text: canonicalId)],
      createVisit: false,
      message: '',
      timeSecs: 0,
    );
    docs[canonicalId] = canonical.save();
    docs[duplicateId] = duplicate.save();
  }

  /// The server's current view of a patient, as decoded JSON.
  Map<String, dynamic> state(String id) =>
      jsonDecode(PatientDoc.load(bytes: docs[id]!, actorHex: _actor).toJson())
          as Map<String, dynamic>;

  void _check() {
    requests++;
    if (down) {
      throw const SyncHttpException(
        "Server didn't respond. Will retry.",
        unreachable: true,
      );
    }
    if (refuse) throw const SyncHttpException('Server returned 500.');
  }

  @override
  Future<bool> reachable() async => !down;

  @override
  void close() {}
}
