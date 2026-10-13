import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../../core/schema.dart';
import '../app_scope.dart';
import '../theme.dart';
import '../visits/visit_form.dart';
import '../widgets.dart';
import 'patient_form.dart';

class PatientDetail extends StatefulWidget {
  const PatientDetail({super.key, required this.patientId});

  final String patientId;

  @override
  State<PatientDetail> createState() => _PatientDetailState();
}

class _Data {
  const _Data(
    this.patient,
    this.merged,
    this.visits,
    this.pending,
    this.problems,
  );

  final Patient? patient;

  /// The patient asked for was merged into another record.
  final bool merged;
  final List<Visit> visits;
  final Set<String> pending;
  final List<String> problems;
}

class _PatientDetailState extends State<PatientDetail> {
  bool _showDeleted = false;

  @override
  Widget build(BuildContext context) {
    return LiveQuery<_Data>(
      load: (app) async {
        // A merged duplicate opens as the record it was merged into, or as
        // itself while that record has not downloaded.
        final p = await app.patients.canonical(widget.patientId);
        final id = p?.id ?? widget.patientId;
        return _Data(
          p,
          p != null && (p.id != widget.patientId || p.isMerged),
          await app.visits.forPatient(id, includeDeleted: true),
          await app.patients.pendingIds(),
          await app.patients.problems(id),
        );
      },
      builder: (context, data) {
        final p = data.patient;
        if (p == null) {
          return const Scaffold(
            appBar: FieldAppBar(title: 'Patient'),
            body: EmptyState(
              icon: Icons.person_off,
              message: 'This patient has not finished downloading.',
            ),
          );
        }
        final waiting = data.pending.contains(p.id);
        final active = data.visits.where((v) => !v.isDeleted).toList();
        final deleted = data.visits.where((v) => v.isDeleted).toList();
        return Scaffold(
          appBar: FieldAppBar(
            title: 'Patient',
            actions: [
              IconButton(
                tooltip: 'Edit patient',
                icon: const Icon(Icons.edit_outlined),
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => PatientForm(patient: p),
                  ),
                ),
              ),
            ],
          ),
          body: ListView(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
            children: [
              _Header(patient: p, waiting: waiting),
              if (data.merged) ...[
                const SizedBox(height: 12),
                const _MergedNote(),
              ],
              if (data.problems.isNotEmpty) ...[
                const SizedBox(height: 12),
                _ProblemsCard(problems: data.problems),
              ],
              const SizedBox(height: 12),
              _DetailsCard(patient: p),
              SectionTitle(
                'Visits',
                trailing: Text(
                  '${active.length} total',
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
              ),
              if (active.isEmpty)
                const EmptyState(
                  icon: Icons.event_note_outlined,
                  message: 'No visits recorded.',
                ),
              for (final v in active) ...[
                _VisitTile(
                  visit: v,
                  waiting: data.pending.contains(v.patientId),
                ),
                const SizedBox(height: 12),
              ],
              if (deleted.isNotEmpty)
                TextButton(
                  onPressed: () => setState(() => _showDeleted = !_showDeleted),
                  child: Text(
                    _showDeleted
                        ? 'Hide deleted visits'
                        : 'Show ${deleted.length} deleted ${deleted.length == 1 ? 'visit' : 'visits'}',
                  ),
                ),
              if (_showDeleted)
                for (final v in deleted) ...[
                  _VisitTile(
                    visit: v,
                    waiting: data.pending.contains(v.patientId),
                  ),
                  const SizedBox(height: 12),
                ],
              const SizedBox(height: 8),
              FilledButton(
                onPressed: () => Navigator.of(context).push(
                  MaterialPageRoute<void>(
                    builder: (_) => VisitForm(patientId: p.id),
                  ),
                ),
                child: const Text('Record new visit'),
              ),
            ],
          ),
        );
      },
    );
  }
}

class _Header extends StatelessWidget {
  const _Header({required this.patient, required this.waiting});

  final Patient patient;
  final bool waiting;

  @override
  Widget build(BuildContext context) {
    final p = patient;
    return Row(
      children: [
        Avatar(p.name),
        const SizedBox(width: 14),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(p.name, style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 6),
              Wrap(
                spacing: 8,
                runSpacing: 6,
                children: [
                  if (p.headOfHousehold) const Tag.teal('Head of household'),
                  if (p.status == 'active')
                    const Tag.teal('Active')
                  else
                    Tag.amber(p.statusLabel),
                ],
              ),
            ],
          ),
        ),
        SyncBadge(waiting: waiting),
      ],
    );
  }
}

class _DetailsCard extends StatelessWidget {
  const _DetailsCard({required this.patient});

  final Patient patient;

  @override
  Widget build(BuildContext context) {
    final registered = DateTime.tryParse(patient.registeredAt)?.toLocal();
    Widget row(IconData icon, String label, String value) => ListTile(
      leading: Icon(icon, color: Palette.teal),
      title: Text(label, style: Theme.of(context).textTheme.bodyMedium),
      subtitle: Text(
        value.isEmpty ? '—' : value,
        style: Theme.of(context).textTheme.bodyLarge,
      ),
    );
    return Card(
      child: Column(
        children: [
          row(Icons.phone, 'Phone', patient.phone),
          row(Icons.place, 'Location', patient.location),
          row(
            Icons.event,
            'Registered',
            registered == null ? '' : dateTimeFormat.format(registered),
          ),
        ],
      ),
    );
  }
}

class _MergedNote extends StatelessWidget {
  const _MergedNote();

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Palette.blueSoft,
        borderRadius: BorderRadius.circular(18),
      ),
      child: const Row(
        children: [
          Icon(Icons.merge_type, color: Palette.blue),
          SizedBox(width: 12),
          Expanded(
            child: Text(
              'Merged with an existing record for this patient.',
              style: TextStyle(
                color: Palette.blue,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ProblemsCard extends StatelessWidget {
  const _ProblemsCard({required this.problems});

  final List<String> problems;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: Palette.redSoft,
        borderRadius: BorderRadius.circular(18),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'The server could not save some values',
            style: TextStyle(
              color: Palette.red,
              fontWeight: FontWeight.w800,
              fontSize: 16,
            ),
          ),
          const SizedBox(height: 6),
          for (final m in problems)
            Text('• $m', style: const TextStyle(color: Palette.ink)),
          const SizedBox(height: 6),
          const Text(
            'Correct them here and they will sync again.',
            style: TextStyle(color: Palette.muted),
          ),
        ],
      ),
    );
  }
}

class _VisitTile extends StatelessWidget {
  const _VisitTile({required this.visit, required this.waiting});

  final Visit visit;
  final bool waiting;

  @override
  Widget build(BuildContext context) {
    final vitals = [
      for (final f in vitalFields)
        if (visit.vitals[f.key]!.isNotEmpty)
          '${f.label} ${visit.vitals[f.key]} ${f.unit}',
    ];
    return RecordCard(
      title: visit.title,
      subtitle: [
        if (visit.isDeleted) 'Deleted',
        if (visit.reason.isNotEmpty) visit.typeLabel,
        ...vitals,
      ].join(' · '),
      trailingTop: visit.time == null ? null : shortWhen(visit.time!),
      trailingBottom: visit.isDeleted
          ? const Tag.red('Deleted')
          : SyncBadge(waiting: waiting),
      onTap: () => Navigator.of(
        context,
      ).push(MaterialPageRoute<void>(builder: (_) => VisitForm(visit: visit))),
    );
  }
}
