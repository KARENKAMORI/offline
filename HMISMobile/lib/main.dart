import 'package:connectivity_plus/connectivity_plus.dart';
import 'package:flutter/material.dart';

import 'core/db.dart';
import 'core/device_profile.dart';
import 'core/doc_store.dart';
import 'core/sync_api.dart';
import 'core/sync_service.dart';
import 'src/rust/frb_generated.dart';
import 'ui/app_scope.dart';
import 'ui/home_shell.dart';
import 'ui/theme.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await RustLib.init();
  final db = await AppDatabase.open();
  final profile = await DeviceProfile.load(db);
  final store = DocStore(db, profile);
  await store.reprojectIfNeeded();
  final sync = SyncService(store: store, api: () => SyncApi(profile.serverUrl));
  await sync.start(
    networkChanges: Connectivity().onConnectivityChanged.map(
      (results) => results.any((r) => r != ConnectivityResult.none),
    ),
  );
  runApp(
    FieldVisitApp(
      services: AppServices(store: store, sync: sync),
    ),
  );
}

class FieldVisitApp extends StatefulWidget {
  const FieldVisitApp({super.key, required this.services});

  final AppServices services;

  @override
  State<FieldVisitApp> createState() => _FieldVisitAppState();
}

class _FieldVisitAppState extends State<FieldVisitApp>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed) {
      widget.services.sync.check();
      widget.services.sync.syncNow();
    }
  }

  @override
  Widget build(BuildContext context) {
    return AppScope(
      services: widget.services,
      child: MaterialApp(
        title: 'FieldVisit',
        debugShowCheckedModeBanner: false,
        theme: buildTheme(),
        home: const HomeShell(),
      ),
    );
  }
}
