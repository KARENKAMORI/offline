import 'package:flutter_test/flutter_test.dart';
import 'package:hmis_mobile/core/doc_store.dart';
import 'package:hmis_mobile/core/identity.dart';
import 'package:hmis_mobile/core/models.dart';
import 'package:hmis_mobile/core/repositories.dart';
import 'package:hmis_mobile/core/sync_service.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

import 'support/harness.dart';

const amina = PatientInput(
  name: 'Amina Wanjiru',
  phone: '0700 000 001',
  status: 'active',
  location: 'Kinangop',
  headOfHousehold: true,
);

VisitInput visitAt(
  DateTime time, {
  String reason = 'Antenatal check',
  Map<String, String> vitals = const {},
}) => VisitInput(
  visitType: 'outpatient',
  time: time,
  reason: reason,
  vitals: vitals,
);

void main() {
  late FakeServer server;
  final devices = <TestDevice>[];

  setUpAll(initTestEnvironment);

  setUp(() => server = FakeServer());

  tearDown(() async {
    for (final d in devices) {
      await d.close();
    }
    devices.clear();
  });

  Future<TestDevice> device([String name = 'Phone']) async {
    final d = await TestDevice.create(() => server, name: name);
    devices.add(d);
    return d;
  }

  test(
    'registration and a visit project into rows and pending changes',
    () async {
      final phone = await device();
      final id = await phone.patients.create(amina);
      final visitId = await phone.visits.create(
        id,
        visitAt(
          DateTime.now(),
          vitals: {'temperature_c': '38.4', 'pulse_bpm': '88'},
        ),
      );

      final patient = (await phone.patients.get(id))!;
      expect(patient.name, 'Amina Wanjiru');
      expect(patient.phone, '+254700000001');
      expect(patient.headOfHousehold, isTrue);

      final visit = (await phone.visits.get(visitId))!;
      expect(visit.reason, 'Antenatal check');
      expect(visit.vitals['temperature_c'], '38.4');
      expect(visit.vitals['weight_kg'], '');
      expect(visit.patientName, 'Amina Wanjiru');
      expect(await phone.visits.onDay(DateTime.now()), hasLength(1));

      final pending = await phone.store.pendingChanges();
      expect(pending.map((c) => (c.verb, c.summary)), [
        (ChangeVerb.added, 'Household: Amina Wanjiru'),
        (ChangeVerb.added, 'Visit: Amina Wanjiru'),
      ]);
      expect(await phone.patients.pendingIds(), {id});
    },
  );

  test('an edit that changes nothing records nothing', () async {
    final phone = await device();
    final id = await phone.patients.create(amina);
    await phone.patients.update(id, amina);
    expect(await phone.store.pendingChanges(), hasLength(1));
  });

  test(
    'sync sends changes, clears pending and reaches a second device',
    () async {
      final phone = await device('Phone');
      final id = await phone.patients.create(amina);
      await phone.visits.create(
        id,
        visitAt(DateTime.now(), vitals: {'spo2_pct': '97'}),
      );

      await phone.sync.syncNow();

      expect(phone.sync.connection, Connection.online);
      expect(await phone.store.pendingChanges(), isEmpty);
      expect(await phone.patients.pendingIds(), isEmpty);
      expect(server.state(id)['patient']['name'], 'Amina Wanjiru');
      final runs = await phone.activity.runs();
      expect(runs.single.outcome, SyncOutcome.done);
      expect(runs.single.detail, '2 changes sent');

      final tablet = await device('Clinic Tablet 2');
      await tablet.sync.syncNow();
      final visits = await tablet.visits.forPatient(id);
      expect(visits.single.vitals['spo2_pct'], '97');
      expect(
        (await tablet.activity.runs()).single.detail,
        '2 changes received',
      );
    },
  );

  test('edits made during a sync stay pending', () async {
    final phone = await device();
    final id = await phone.patients.create(amina);
    final running = phone.sync.syncNow();
    await phone.patients.update(
      id,
      const PatientInput(
        name: 'Amina W.',
        phone: '',
        status: 'active',
        location: 'Kinangop',
        headOfHousehold: true,
      ),
    );
    await running;
    // Whether or not the edit made it into this run, it must not be lost.
    await phone.sync.syncNow();
    expect(server.state(id)['patient']['name'], 'Amina W.');
    expect(await phone.patients.pendingIds(), isEmpty);
  });

  test(
    'different fields edited offline merge and show a merge notice',
    () async {
      final phone = await device('Phone');
      final tablet = await device('Clinic Tablet 2');
      final id = await phone.patients.create(amina);
      await phone.sync.syncNow();
      await tablet.sync.syncNow();

      await tablet.patients.update(
        id,
        const PatientInput(
          name: 'Amina Wanjiru',
          phone: '0711111111',
          status: 'active',
          location: 'Kinangop',
          headOfHousehold: true,
        ),
      );
      await phone.patients.update(
        id,
        const PatientInput(
          name: 'Amina Wanjiru',
          phone: '0700000001',
          status: 'active',
          location: 'Engineer',
          headOfHousehold: true,
        ),
      );
      await tablet.sync.syncNow();
      await phone.sync.syncNow();

      final merged = (await phone.patients.get(id))!;
      expect((merged.phone, merged.location), ('+254711111111', 'Engineer'));
      final notices = await phone.activity.notices();
      expect(notices.single.title, 'Merged a change from Clinic Tablet 2');
      expect(await phone.activity.replacedEdits(), isEmpty);
      expect((await phone.activity.runs()).first.outcome, SyncOutcome.merged);

      await phone.activity.dismissNotice(notices.single.id);
      expect(await phone.activity.notices(), isEmpty);
    },
  );

  test(
    'same field edited offline: the losing device can re-enter its value',
    () async {
      final phone = await device('Phone');
      final tablet = await device('Clinic Tablet 2');
      final id = await phone.patients.create(amina);
      final visitId = await phone.visits.create(id, visitAt(DateTime.now()));
      await phone.sync.syncNow();
      await tablet.sync.syncNow();

      final onPhone = (await phone.visits.get(visitId))!;
      final onTablet = (await tablet.visits.get(visitId))!;
      await phone.visits.update(
        onPhone,
        visitAt(onPhone.time!, vitals: {'temperature_c': '38.4'}),
      );
      await tablet.visits.update(
        onTablet,
        visitAt(onTablet.time!, vitals: {'temperature_c': '37.9'}),
      );
      await phone.sync.syncNow();
      await tablet.sync.syncNow();
      await phone.sync.syncNow();

      // Exactly one device lost, and only that device is told.
      final phoneLost = await phone.activity.replacedEdits();
      final tabletLost = await tablet.activity.replacedEdits();
      expect(phoneLost.length + tabletLost.length, 1);
      final (loser, lost) = phoneLost.isNotEmpty
          ? (phone, phoneLost.single)
          : (tablet, tabletLost.single);
      expect(lost.key, 'temperature_c');
      expect({lost.mine, lost.kept}, {'38.4', '37.9'});
      expect(lost.keptBy, loser == phone ? 'Clinic Tablet 2' : 'Phone');

      await loser.activity.resolve(lost, keepMine: true);
      expect(await loser.activity.replacedEdits(), isEmpty);
      await loser.sync.syncNow();
      final other = loser == phone ? tablet : phone;
      await other.sync.syncNow();
      for (final d in [phone, tablet]) {
        expect(
          (await d.visits.get(visitId))!.vitals['temperature_c'],
          lost.mine,
        );
        expect(await d.activity.replacedEdits(), isEmpty);
      }
    },
  );

  test(
    'deleting a visit hides it everywhere and restore brings it back',
    () async {
      final phone = await device();
      final tablet = await device('Clinic Tablet 2');
      final id = await phone.patients.create(amina);
      final visitId = await phone.visits.create(id, visitAt(DateTime.now()));
      await phone.visits.delete((await phone.visits.get(visitId))!);

      expect(await phone.visits.all(), isEmpty);
      expect(await phone.visits.onDay(DateTime.now()), isEmpty);
      expect(
        await phone.visits.forPatient(id, includeDeleted: true),
        hasLength(1),
      );
      expect(
        (await phone.store.pendingChanges()).last.verb,
        ChangeVerb.deleted,
      );

      await phone.sync.syncNow();
      await tablet.sync.syncNow();
      expect(await tablet.visits.all(), isEmpty);
      expect(server.state(id)['visits'][visitId]['deleted_at'], isNotEmpty);

      await tablet.visits.restore((await tablet.visits.get(visitId))!);
      await tablet.sync.syncNow();
      await phone.sync.syncNow();
      expect(await phone.visits.all(), hasLength(1));
    },
  );

  test(
    'a down server records one failed run per outage and keeps changes',
    () async {
      final phone = await device();
      await phone.patients.create(amina);
      server.down = true;
      await phone.sync.syncNow();
      await phone.sync.syncNow();

      expect(phone.sync.connection, Connection.offline);
      expect(phone.sync.lastError, "Server didn't respond. Will retry.");
      final runs = await phone.activity.runs();
      expect(runs.single.outcome, SyncOutcome.failed);
      expect(await phone.store.pendingChanges(), hasLength(1));

      server.down = false;
      await phone.sync.syncNow();
      expect(await phone.store.pendingChanges(), isEmpty);
      expect((await phone.activity.runCounts())[SyncOutcome.done], 1);
    },
  );

  test(
    'shows online as soon as the server answers again, then syncs',
    () async {
      final phone = await device();
      await phone.patients.create(amina);
      final sync = SyncService(
        store: phone.store,
        api: () => server,
        interval: const Duration(hours: 1),
        checkOffline: const Duration(milliseconds: 10),
      );
      addTearDown(sync.dispose);

      // The phone reports wifi before requests get through.
      server.down = true;
      await sync.start();
      expect(sync.connection, Connection.offline);

      server.down = false;
      for (var i = 0; i < 200 && sync.lastSyncedAt == null; i++) {
        await Future<void>.delayed(const Duration(milliseconds: 10));
      }
      expect(sync.connection, Connection.online);
      expect(await phone.store.pendingChanges(), isEmpty);
    },
  );

  test('stays online when the server answers but refuses the sync', () async {
    final phone = await device();
    await phone.patients.create(amina);
    await phone.sync.syncNow();
    await phone.patients.create(
      const PatientInput(
        name: 'Baraka Otieno',
        phone: '0700 000 002',
        status: 'active',
        location: 'Kinangop',
        headOfHousehold: false,
      ),
    );

    server.refuse = true;
    await phone.sync.syncNow();

    expect(phone.sync.connection, Connection.online);
    expect(phone.sync.lastError, 'Server returned 500.');
    expect(await phone.store.pendingChanges(), hasLength(1));
  });

  test(
    'a patient from the server cannot be edited before it downloads',
    () async {
      final phone = await device();
      await expectLater(
        phone.visits.create(
          '00000000-0000-4000-8000-000000000000',
          visitAt(DateTime.now()),
        ),
        throwsA(isA<StateError>()),
      );
    },
  );

  test('phones and names normalise like HMIS/patients/identity.py', () {
    for (final (raw, normalised) in [
      ('0712 111-222', '+254712111222'),
      ('712111222', '+254712111222'),
      ('254712111222', '+254712111222'),
      ('+254712111222', '+254712111222'),
      ('00254712111222', '+254712111222'),
      ('0112345678', '+254112345678'),
      ('(0712) 111.222', '+254712111222'),
      ('+256772000000', '+256772000000'),
      ('12345', '12345'),
      ('', ''),
    ]) {
      expect(normalizePhone(raw), normalised, reason: raw);
    }
    for (final (raw, normalised) in [
      ('Njeri-GRACE ', 'grace njeri'),
      ('José  Ñúñez', 'jose nunez'),
      ('Grace_Njeri', 'grace njeri'),
      ('njeri  GRACE', 'grace njeri'),
      ('Strauß', 'strauss'),
      ('', ''),
    ]) {
      expect(normalizeName(raw), normalised, reason: raw);
    }
  });

  /// Registers Amina on two devices offline; the tablet's copy syncs second,
  /// so the server merges it into the phone's.
  Future<(TestDevice, String, String, String)> registeredTwice() async {
    final phone = await device('Phone');
    final tablet = await device('Clinic Tablet 2');
    final original = await phone.patients.create(amina);
    final duplicate = await tablet.patients.create(amina);
    final visitId = await tablet.visits.create(
      duplicate,
      visitAt(DateTime.now()),
    );
    await phone.sync.syncNow();
    await tablet.sync.syncNow();
    server.merge(duplicate, original);
    await tablet.sync.syncNow();
    return (tablet, original, duplicate, visitId);
  }

  test(
    'a duplicate merged by the server is hidden and opens as the original',
    () async {
      final (tablet, original, duplicate, visitId) = await registeredTwice();

      expect((await tablet.patients.all()).map((p) => p.id), [original]);
      expect((await tablet.patients.all(search: '0700 000')).map((p) => p.id), [
        original,
      ]);
      expect((await tablet.patients.get(duplicate))!.mergedInto, original);
      expect((await tablet.patients.canonical(duplicate))!.id, original);
      expect((await tablet.patients.canonical(original))!.id, original);
      // The copied visit is listed once, under the original.
      expect((await tablet.visits.get(visitId))!.patientId, original);
      expect((await tablet.visits.forPatient(original)).map((v) => v.id), [
        visitId,
      ]);
      expect(await tablet.visits.all(), hasLength(1));
    },
  );

  test(
    'a visit recorded for a merged patient goes into the original',
    () async {
      final (tablet, original, duplicate, _) = await registeredTwice();

      final visitId = await tablet.visits.create(
        duplicate,
        visitAt(DateTime.now(), reason: 'Follow-up'),
      );
      expect((await tablet.visits.get(visitId))!.patientId, original);
      expect(await tablet.patients.pendingIds(), {original});

      await tablet.sync.syncNow();
      expect(server.state(original)['visits'], contains(visitId));
      expect(server.state(duplicate)['visits'], isNot(contains(visitId)));
      expect(server.state(duplicate)['patient']['merged_into'], original);
    },
  );

  test('a duplicate whose original has not downloaded stays usable', () async {
    final phone = await device();
    final a = await phone.patients.create(amina);
    final b = await phone.patients.create(amina);
    // Stand-ins for server writes; the app itself never writes merged_into.
    Future<void> mergeInto(String id, String into) => phone.store.change(
      id,
      const ['patient'],
      [textField('merged_into', into)],
      kind: 'test',
      summary: 'test',
    );
    await mergeInto(a, '00000000-0000-4000-8000-000000000000');

    expect((await phone.patients.all()).map((p) => p.id), [b]);
    final shown = (await phone.patients.canonical(a))!;
    expect((shown.id, shown.isMerged), (a, true));
    final visitId = await phone.visits.create(a, visitAt(DateTime.now()));
    expect((await phone.visits.get(visitId))!.patientId, a);

    // A cycle ends instead of looping.
    await mergeInto(a, b);
    await mergeInto(b, a);
    expect(await phone.patients.all(), isEmpty);
    expect((await phone.patients.canonical(a))!.id, b);
  });

  test(
    'upgrading from schema v2 projects merged_into from stored documents',
    () async {
      final (tablet, original, duplicate, visitId) = await registeredTwice();
      devices.remove(tablet);

      final upgraded = await tablet.restart(
        () => server,
        beforeOpen: (path) async {
          // Roll the file back to v2, as an older app version left it.
          final db = await databaseFactory.openDatabase(path);
          await db.execute('ALTER TABLE patients DROP COLUMN merged_into');
          await db.setVersion(2);
          await db.close();
        },
      );
      devices.add(upgraded);

      expect((await upgraded.patients.all()).map((p) => p.id), [original]);
      expect((await upgraded.patients.get(duplicate))!.mergedInto, original);
      expect((await upgraded.visits.get(visitId))!.patientId, original);
      expect(await upgraded.store.pendingChanges(), isEmpty);
    },
  );
}
