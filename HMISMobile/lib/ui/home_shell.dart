import 'package:flutter/material.dart';

import 'patients/patients_screen.dart';
import 'profile/profile_screen.dart';
import 'sync/sync_screen.dart';
import 'theme.dart';
import 'visits/visits_home.dart';

class HomeShell extends StatefulWidget {
  const HomeShell({super.key});

  @override
  State<HomeShell> createState() => _HomeShellState();
}

class _HomeShellState extends State<HomeShell> {
  int _index = 0;

  static const _labels = ['Visits', 'Patients', 'Sync', 'Profile'];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: IndexedStack(
        index: _index,
        children: const [
          VisitsHome(),
          PatientsScreen(),
          SyncScreen(),
          ProfileScreen(),
        ],
      ),
      bottomNavigationBar: DecoratedBox(
        decoration: const BoxDecoration(
          color: Palette.surface,
          border: Border(top: BorderSide(color: Palette.divider)),
        ),
        child: SafeArea(
          child: SizedBox(
            height: 76,
            child: Row(
              children: [
                for (var i = 0; i < _labels.length; i++)
                  Expanded(child: _tab(i)),
              ],
            ),
          ),
        ),
      ),
    );
  }

  Widget _tab(int i) {
    final selected = i == _index;
    return Semantics(
      selected: selected,
      button: true,
      label: _labels[i],
      excludeSemantics: true,
      child: InkWell(
        onTap: () => setState(() => _index = i),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            CircleAvatar(
              radius: 6,
              backgroundColor: selected ? Palette.teal : Palette.navIdle,
            ),
            const SizedBox(height: 10),
            Text(
              _labels[i],
              style: TextStyle(
                fontSize: 15,
                color: selected ? Palette.ink : Palette.muted,
                fontWeight: selected ? FontWeight.w700 : FontWeight.w400,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
