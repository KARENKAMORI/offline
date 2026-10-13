import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hmis_mobile/core/repositories.dart';
import 'package:hmis_mobile/main.dart';
import 'package:hmis_mobile/ui/app_scope.dart';

import 'support/harness.dart';

/// Lets database work (real async, off the fake clock) finish, then rebuilds.
Future<void> settle(WidgetTester tester) async {
  for (var i = 0; i < 6; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 30)),
    );
    await tester.pump(const Duration(milliseconds: 300));
  }
}

/// Runs [op] on the real clock while pumping frames. Awaiting it inside a
/// single runAsync would deadlock: screens rebuilt meanwhile query SQLite on
/// the fake clock, and sqflite runs one query at a time.
Future<void> drive(WidgetTester tester, Future<void> Function() op) async {
  late Future<void> running;
  var done = false;
  await tester.runAsync(() async {
    running = op().whenComplete(() => done = true);
  });
  for (var i = 0; i < 200 && !done; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
    await tester.pump(const Duration(milliseconds: 100));
  }
  await tester.runAsync(() => running);
  await settle(tester);
}

Future<void> tapAndSettle(WidgetTester tester, Finder finder) async {
  await tester.ensureVisible(finder);
  await tester.pump();
  await tester.tap(finder);
  await settle(tester);
}

void main() {
  setUpAll(initTestEnvironment);

  testWidgets('register, record a visit, sync and set the profile', (
    tester,
  ) async {
    // Tall enough that lazily built lists show every row without scrolling.
    tester.view.physicalSize = const Size(420, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    final server = FakeServer();
    final phone = (await tester.runAsync(
      () => TestDevice.create(() => server, name: 'Phone'),
    ))!;
    addTearDown(() => tester.runAsync(phone.close));
    await tester.pumpWidget(
      FieldVisitApp(
        services: AppServices(store: phone.store, sync: phone.sync),
      ),
    );
    await settle(tester);
    expect(find.text('FieldVisit'), findsOneWidget);
    expect(find.text('0 visits today'), findsOneWidget);

    // Register a patient.
    await tapAndSettle(tester, find.text('Patients'));
    await tapAndSettle(tester, find.text('Register patient'));
    await tester.enterText(
      find.widgetWithText(TextFormField, 'Full name'),
      'Grace Njeri',
    );
    await tester.enterText(
      find.widgetWithText(TextFormField, 'Location'),
      'Kinangop',
    );
    await tapAndSettle(tester, find.text('Head of household'));
    await tapAndSettle(
      tester,
      find.widgetWithText(FilledButton, 'Register patient'),
    );
    expect(find.text('Grace Njeri'), findsOneWidget);
    expect(find.text('Waiting'), findsOneWidget);

    // Record a visit from the patient's page; an out-of-range vital is refused.
    await tapAndSettle(tester, find.text('Grace Njeri'));
    await tapAndSettle(
      tester,
      find.widgetWithText(FilledButton, 'Record new visit'),
    );
    await tester.enterText(
      find.widgetWithText(TextFormField, 'e.g. Antenatal check, Malaria test'),
      'Child immunisation',
    );
    final temperature = find.widgetWithText(TextFormField, 'Temperature');
    await tester.enterText(temperature, '49');
    await tapAndSettle(
      tester,
      find.widgetWithText(FilledButton, 'Record visit'),
    );
    expect(find.text('30.0 to 45.0'), findsOneWidget);
    await tester.enterText(temperature, '38.4');
    await tapAndSettle(
      tester,
      find.widgetWithText(FilledButton, 'Record visit'),
    );
    expect(find.text('Child immunisation'), findsOneWidget);
    expect(find.textContaining('Temperature 38.4 °C'), findsOneWidget);
    await tester.pageBack();
    await settle(tester);

    // Today's visits shows it as waiting to sync.
    await tapAndSettle(tester, find.text('Visits'));
    expect(find.text('1 visit today'), findsOneWidget);
    expect(find.text('1 saved on this phone, waiting to sync'), findsOneWidget);

    // Sync it.
    await tapAndSettle(tester, find.text('Sync'));
    expect(find.text('2 changes waiting to sync'), findsOneWidget);
    await drive(tester, phone.sync.syncNow);
    expect(find.text('Everything is synced'), findsOneWidget);
    expect(server.docs, hasLength(1));
    await tapAndSettle(tester, find.text('Sync history'));
    expect(find.text('Sync complete'), findsOneWidget);
    expect(find.text('2 changes sent'), findsOneWidget);
    await tester.pageBack();
    await settle(tester);

    // Profile name appears in the greeting.
    await tapAndSettle(tester, find.text('Profile'));
    await tester.enterText(
      find.widgetWithText(TextFormField, 'Your name'),
      'Nurse Wairimu',
    );
    await tapAndSettle(tester, find.widgetWithText(FilledButton, 'Save'));
    await tapAndSettle(tester, find.text('Visits'));
    expect(find.textContaining('Nurse Wairimu'), findsOneWidget);
    expect(find.text('1 visit today'), findsOneWidget);
    expect(find.text('All saved to the server.'), findsOneWidget);
  });

  testWidgets('registering a known phone number warns first', (tester) async {
    tester.view.physicalSize = const Size(420, 2400);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);

    final server = FakeServer();
    final phone = (await tester.runAsync(
      () => TestDevice.create(() => server, name: 'Phone'),
    ))!;
    addTearDown(() => tester.runAsync(phone.close));
    await tester.runAsync(
      () => phone.patients.create(
        const PatientInput(
          name: 'Grace Njeri',
          phone: '0712 111222',
          status: 'active',
          location: 'Kinangop',
          headOfHousehold: false,
        ),
      ),
    );
    await tester.pumpWidget(
      FieldVisitApp(
        services: AppServices(store: phone.store, sync: phone.sync),
      ),
    );
    await settle(tester);
    await tapAndSettle(tester, find.text('Patients'));

    Future<void> register(String name, String number) async {
      await tapAndSettle(tester, find.text('Register patient'));
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Full name'),
        name,
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Phone (optional)'),
        number,
      );
      await tester.enterText(
        find.widgetWithText(TextFormField, 'Location'),
        'Kinangop',
      );
      await tapAndSettle(
        tester,
        find.widgetWithText(FilledButton, 'Register patient'),
      );
    }

    // Same person: open the existing record instead.
    await register('njeri grace', '+254712111222');
    expect(
      find.text('Grace Njeri (+254712111222) is already registered.'),
      findsOneWidget,
    );
    await tapAndSettle(tester, find.text('Open existing'));
    expect(find.text('Record new visit'), findsOneWidget);
    await tester.pageBack();
    await settle(tester);
    expect(find.text('Grace Njeri'), findsOneWidget);

    // Someone else in the household: say who, then register.
    await register('Peter Kamau', '712-111-222');
    expect(
      find.text('This number is also used by Grace Njeri.'),
      findsOneWidget,
    );
    await tapAndSettle(tester, find.text('Continue'));
    expect(find.text('Peter Kamau'), findsOneWidget);
    expect(find.text('Grace Njeri'), findsOneWidget);
  });
}
