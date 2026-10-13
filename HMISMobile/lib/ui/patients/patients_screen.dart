import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../app_scope.dart';
import '../widgets.dart';
import 'patient_detail.dart';
import 'patient_form.dart';

class PatientsScreen extends StatefulWidget {
  const PatientsScreen({super.key});

  @override
  State<PatientsScreen> createState() => _PatientsScreenState();
}

class _PatientsScreenState extends State<PatientsScreen> {
  String _search = '';

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: const FieldAppBar(title: 'Patients'),
      floatingActionButton: FloatingActionButton.extended(
        onPressed: () => Navigator.of(context)
            .push(MaterialPageRoute<void>(builder: (_) => const PatientForm())),
        icon: const Icon(Icons.person_add_alt_1),
        label: const Text(
          'Register patient',
          style: TextStyle(fontWeight: FontWeight.w800),
        ),
      ),
      body: Column(
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
            child: TextField(
              decoration: const InputDecoration(
                hintText: 'Search name, phone or location',
                prefixIcon: Icon(Icons.search),
              ),
              onChanged: (v) => setState(() => _search = v),
            ),
          ),
          Expanded(
            child: LiveQuery<(List<Patient>, Set<String>)>(
              load: (app) async => (
                await app.patients.all(search: _search),
                await app.patients.pendingIds(),
              ),
              builder: (context, data) {
                final (patients, pending) = data;
                if (patients.isEmpty) {
                  return EmptyState(
                    icon: Icons.people_outline,
                    message: _search.isEmpty
                        ? 'No patients on this phone yet.\nRegister one, or sync to download.'
                        : 'No patients match your search.',
                  );
                }
                return ListView.separated(
                  padding: const EdgeInsets.fromLTRB(16, 8, 16, 96),
                  itemCount: patients.length,
                  separatorBuilder: (_, _) => const SizedBox(height: 12),
                  itemBuilder: (context, i) => _PatientCard(
                    patient: patients[i],
                    waiting: pending.contains(patients[i].id),
                  ),
                );
              },
            ),
          ),
        ],
      ),
    );
  }
}

class _PatientCard extends StatelessWidget {
  const _PatientCard({required this.patient, required this.waiting});

  final Patient patient;
  final bool waiting;

  @override
  Widget build(BuildContext context) {
    final p = patient;
    return RecordCard(
      leading: Avatar(p.name),
      title: p.name,
      subtitle: [
        if (p.headOfHousehold) 'Head of household',
        if (p.status != 'active') p.statusLabel,
        if (p.location.isNotEmpty) p.location,
        if (p.phone.isNotEmpty) p.phone,
      ].join(' · '),
      trailingBottom: SyncBadge(waiting: waiting),
      onTap: () => Navigator.of(context).push(
        MaterialPageRoute<void>(builder: (_) => PatientDetail(patientId: p.id)),
      ),
    );
  }
}
