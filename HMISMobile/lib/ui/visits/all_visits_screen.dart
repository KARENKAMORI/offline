import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../app_scope.dart';
import '../widgets.dart';
import 'visit_form.dart';

/// Every visit, newest first, grouped by day.
class AllVisitsScreen extends StatelessWidget {
  const AllVisitsScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: const FieldAppBar(title: 'All visits'),
      body: LiveQuery<(List<Visit>, Set<String>)>(
        load: (app) async =>
            (await app.visits.all(), await app.patients.pendingIds()),
        builder: (context, data) {
          final (visits, pending) = data;
          if (visits.isEmpty) {
            return const EmptyState(
              icon: Icons.event_note_outlined,
              message: 'No visits recorded yet.',
            );
          }
          final children = <Widget>[];
          String? day;
          for (final v in visits) {
            final label = v.time == null
                ? 'Unknown date'
                : dayFormat.format(v.time!);
            if (label != day) {
              day = label;
              children.add(SectionTitle(label));
            }
            final name = v.patientName ?? 'Unknown patient';
            children
              ..add(
                RecordCard(
                  leading: Avatar(name),
                  title: name,
                  subtitle: v.title,
                  trailingTop: v.time == null
                      ? null
                      : timeFormat.format(v.time!),
                  trailingBottom: SyncBadge(
                    waiting: pending.contains(v.patientId),
                  ),
                  onTap: () => Navigator.of(context).push(
                    MaterialPageRoute<void>(
                      builder: (_) => VisitForm(visit: v),
                    ),
                  ),
                ),
              )
              ..add(const SizedBox(height: 12));
          }
          return ListView(
            padding: const EdgeInsets.fromLTRB(16, 0, 16, 32),
            children: children,
          );
        },
      ),
    );
  }
}
