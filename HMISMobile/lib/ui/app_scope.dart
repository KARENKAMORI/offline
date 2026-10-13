import 'package:flutter/widgets.dart';

import '../core/device_profile.dart';
import '../core/doc_store.dart';
import '../core/repositories.dart';
import '../core/sync_service.dart';

/// The app's services, available to every screen.
class AppServices {
  AppServices({required this.store, required this.sync})
    : patients = PatientRepository(store),
      visits = VisitRepository(store),
      activity = ActivityRepository(store);

  final DocStore store;
  final SyncService sync;
  final PatientRepository patients;
  final VisitRepository visits;
  final ActivityRepository activity;

  DeviceProfile get profile => store.profile;
}

class AppScope extends InheritedWidget {
  const AppScope({super.key, required this.services, required super.child});

  final AppServices services;

  static AppServices of(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<AppScope>()!.services;

  /// Like [of] without subscribing to changes; safe in initState.
  static AppServices read(BuildContext context) =>
      context.getInheritedWidgetOfExactType<AppScope>()!.services;

  @override
  bool updateShouldNotify(AppScope old) => services != old.services;
}

/// Runs [load] now and again whenever stored data changes, keeping the last
/// result on screen while it reloads.
class LiveQuery<T> extends StatefulWidget {
  const LiveQuery({super.key, required this.load, required this.builder});

  final Future<T> Function(AppServices app) load;
  final Widget Function(BuildContext context, T data) builder;

  @override
  State<LiveQuery<T>> createState() => _LiveQueryState<T>();
}

class _LiveQueryState<T> extends State<LiveQuery<T>> {
  AppServices? _app;
  T? _data;
  Object? _error;
  bool _loaded = false;
  int _generation = 0;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final app = AppScope.of(context);
    if (app != _app) {
      _app?.store.removeListener(_reload);
      _app = app..store.addListener(_reload);
      _reload();
    }
  }

  @override
  void didUpdateWidget(LiveQuery<T> old) {
    super.didUpdateWidget(old);
    _reload();
  }

  Future<void> _reload() async {
    final generation = ++_generation;
    try {
      final data = await widget.load(_app!);
      if (!mounted || generation != _generation) return;
      setState(() {
        _data = data;
        _error = null;
        _loaded = true;
      });
    } on Object catch (e) {
      if (!mounted || generation != _generation) return;
      setState(() => _error = e);
    }
  }

  @override
  void dispose() {
    _app?.store.removeListener(_reload);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (_error != null && !_loaded) {
      return Center(child: Text('Could not load: $_error'));
    }
    if (!_loaded) return const SizedBox.shrink();
    return widget.builder(context, _data as T);
  }
}
