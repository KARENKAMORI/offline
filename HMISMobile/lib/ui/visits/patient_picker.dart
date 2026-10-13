import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../app_scope.dart';
import '../theme.dart';
import '../widgets.dart';

/// Searchable list of patients in a bottom sheet.
Future<Patient?> pickPatient(BuildContext context) {
  return showModalBottomSheet<Patient>(
    context: context,
    isScrollControlled: true,
    showDragHandle: true,
    backgroundColor: Palette.background,
    builder: (_) =>
        const FractionallySizedBox(heightFactor: 0.85, child: _Picker()),
  );
}

class _Picker extends StatefulWidget {
  const _Picker();

  @override
  State<_Picker> createState() => _PickerState();
}

class _PickerState extends State<_Picker> {
  String _search = '';

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
          child: TextField(
            autofocus: true,
            decoration: const InputDecoration(
              hintText: 'Search name, phone or location',
              prefixIcon: Icon(Icons.search),
            ),
            onChanged: (v) => setState(() => _search = v),
          ),
        ),
        Expanded(
          child: LiveQuery<List<Patient>>(
            load: (app) => app.patients.all(search: _search),
            builder: (context, patients) => patients.isEmpty
                ? const EmptyState(
                    icon: Icons.person_search,
                    message: 'No patients match. Register them from the Patients tab.',
                  )
                : ListView.separated(
                    padding: const EdgeInsets.fromLTRB(16, 0, 16, 24),
                    itemCount: patients.length,
                    separatorBuilder: (_, _) => const SizedBox(height: 10),
                    itemBuilder: (context, i) {
                      final p = patients[i];
                      return RecordCard(
                        leading: Avatar(p.name),
                        title: p.name,
                        subtitle: [
                          p.location,
                          p.phone,
                        ].where((s) => s.isNotEmpty).join(' · '),
                        onTap: () => Navigator.of(context).pop(p),
                      );
                    },
                  ),
          ),
        ),
      ],
    );
  }
}
