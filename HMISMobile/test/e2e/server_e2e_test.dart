// Syncs real devices through a running HMIS server. Skipped unless
// HMIS_SERVER is set, e.g.
//
//   HMIS_SERVER=http://127.0.0.1:8765 E2E_OUT=/tmp/e2e flutter test test/e2e
//
// Phase "one" (default) runs the scenario and writes the patient id and the
// phone's view of the document to E2E_OUT. Phase "two" pulls the same patient
// onto a fresh phone after another client (HMISWeb's Automerge) edited it.
import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:hmis_mobile/core/doc_store.dart';
import 'package:hmis_mobile/core/repositories.dart';
import 'package:hmis_mobile/core/sync_api.dart';
import 'package:http/http.dart' as http;

import '../support/harness.dart';

final server = Platform.environment['HMIS_SERVER'];
final out = Platform.environment['E2E_OUT'] ?? Directory.systemTemp.path;
final phase = Platform.environment['E2E_PHASE'] ?? 'one';

Future<dynamic> getJson(String path) async {
  final res = await http.get(Uri.parse('$server$path'));
  expect(res.statusCode, 200, reason: res.body);
  return jsonDecode(res.body);
}

void main() {
  setUpAll(initTestEnvironment);

  Future<TestDevice> device(String name) =>
      TestDevice.create(() => SyncApi(server!), name: name);

  test('phase one: mobile devices sync through the real server', () async {
    final phone = await device('Phone');
    final tablet = await device('Clinic Tablet 2');
    addTearDown(phone.close);
    addTearDown(tablet.close);

    final id = await phone.patients.create(
      const PatientInput(
        name: 'Amina E2E',
        phone: '0700000001',
        status: 'active',
        location: 'Kinangop',
        headOfHousehold: true,
      ),
    );
    final visitA = await phone.visits.create(
      id,
      VisitInput(
        visitType: 'outpatient',
        time: DateTime.utc(2026, 10, 11, 8, 15),
        reason: 'Antenatal check',
        vitals: const {
          'temperature_c': '38.4',
          'pulse_bpm': '88',
          'weight_kg': '61.5',
        },
      ),
    );
    final visitB = await phone.visits.create(
      id,
      VisitInput(
        visitType: 'follow_up',
        time: DateTime.utc(2026, 10, 11, 9),
        reason: 'Duplicate visit',
        vitals: const {},
      ),
    );
    await phone.visits.delete((await phone.visits.get(visitB))!);
    await phone.sync.syncNow();
    expect(phone.sync.lastError, isNull);
    expect(await phone.store.pendingChanges(), isEmpty);

    // The server projected the document into its REST tables.
    final patients = await getJson('/api/patients/') as List;
    final row = patients.singleWhere((p) => p['uuid'] == id);
    expect(row['name'], 'Amina E2E');
    expect(row['head_of_household'], isTrue);
    final visible = (await getJson('/api/patients/visits/') as List)
        .where((v) => v['patient'] == row['id'])
        .toList();
    expect(visible.single['uuid'], visitA);
    expect(visible.single['reason'], 'Antenatal check');
    expect(visible.single['temperature_c'], '38.4');
    expect(visible.single['pulse_bpm'], 88);
    final all = (await getJson(
      '/api/patients/visits/?include_deleted=true',
    ) as List).where((v) => v['patient'] == row['id']);
    expect(
      all.singleWhere((v) => v['uuid'] == visitB)['deleted_at'],
      isNotNull,
    );

    // A second device downloads it, deleted visit hidden.
    await tablet.sync.syncNow();
    expect((await tablet.visits.forPatient(id)).single.id, visitA);

    // Both edit offline: different patient fields merge, the same vital conflicts.
    await phone.store.change(
      id,
      ['patient'],
      [textField('location', 'Engineer')],
      kind: 'patient.update',
      summary: 'Patient: Amina E2E',
    );
    await tablet.store.change(
      id,
      ['patient'],
      [textField('phone', '0711111111')],
      kind: 'patient.update',
      summary: 'Patient: Amina E2E',
    );
    await phone.store.change(
      id,
      ['visits', visitA],
      [textField('temperature_c', '39.1')],
      kind: 'visit.vitals',
      summary: 'Vitals: Amina E2E',
    );
    await tablet.store.change(
      id,
      ['visits', visitA],
      [textField('temperature_c', '37.9')],
      kind: 'visit.vitals',
      summary: 'Vitals: Amina E2E',
    );
    await phone.sync.syncNow();
    await tablet.sync.syncNow();
    await phone.sync.syncNow();

    final p1 = (await phone.patients.get(id))!;
    final p2 = (await tablet.patients.get(id))!;
    expect((p1.location, p1.phone), ('Engineer', '0711111111'));
    expect((p2.location, p2.phone), ('Engineer', '0711111111'));
    final t1 = (await phone.visits.get(visitA))!.vitals['temperature_c'];
    expect((await tablet.visits.get(visitA))!.vitals['temperature_c'], t1);
    final lost = [
      ...await phone.activity.replacedEdits(),
      ...await tablet.activity.replacedEdits(),
    ];
    expect(lost.single.key, 'temperature_c');
    expect(lost.single.kept, t1);
    expect(lost.single.keptBy, anyOf('Phone', 'Clinic Tablet 2'));

    // A REST edit on the server reaches the phone; it has no device name.
    final patch = await http.patch(
      Uri.parse('$server/api/patients/${row['id']}/'),
      headers: {'content-type': 'application/json'},
      body: jsonEncode({'status': 'inactive'}),
    );
    expect(patch.statusCode, 200, reason: patch.body);
    await phone.sync.syncNow();
    expect((await phone.patients.get(id))!.status, 'inactive');

    // An invalid value merges (a CRDT cannot refuse it) but is reported back.
    await phone.store.change(
      id,
      ['visits', visitA],
      [textField('spo2_pct', '140')],
      kind: 'visit.vitals',
      summary: 'Vitals: Amina E2E',
    );
    await phone.sync.syncNow();
    expect((await phone.patients.problems(id)).single, contains('spo2_pct'));
    await phone.store.change(
      id,
      ['visits', visitA],
      [textField('spo2_pct', '97')],
      kind: 'visit.vitals',
      summary: 'Vitals: Amina E2E',
    );
    await phone.sync.syncNow();
    expect(await phone.patients.problems(id), isEmpty);

    File('$out/e2e.json').writeAsStringSync(
      jsonEncode({
        'patient': id,
        'visit_a': visitA,
        'visit_b': visitB,
        'phone_doc': jsonDecode(
          (await phone.store.loadForSync([id]))[id]!.toJson(),
        ),
      }),
    );
  }, skip: server == null || phase != 'one' ? 'Set HMIS_SERVER to run' : false);

  test(
    'phase two: a fresh phone sees edits made with Automerge JS',
    () async {
      final state = jsonDecode(File('$out/e2e.json').readAsStringSync());
      final fresh = await device('Fresh phone');
      addTearDown(fresh.close);
      await fresh.sync.syncNow();
      expect(fresh.sync.lastError, isNull);

      final visit = (await fresh.visits.get(state['visit_a'] as String))!;
      expect(visit.reason, 'Antenatal check (edited on web)');
      expect(visit.vitals['respiratory_rate'], '18');
      final pending = await fresh.store.pendingChanges();
      expect(pending, isEmpty);
      File('$out/e2e_fresh.json').writeAsStringSync(
        (await fresh.store.loadForSync([
          state['patient'] as String,
        ]))[state['patient']]!.toJson(),
      );
    },
    skip: server == null || phase != 'two'
        ? 'Set HMIS_SERVER and E2E_PHASE=two'
        : false,
  );
}
