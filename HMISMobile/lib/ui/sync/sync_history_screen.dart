import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../app_scope.dart';
import '../theme.dart';
import '../widgets.dart';

class SyncHistoryScreen extends StatelessWidget {
  const SyncHistoryScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: const FieldAppBar(title: 'Sync history'),
      body: LiveQuery<(Map<SyncOutcome, int>, List<SyncRun>)>(
        load: (app) async =>
            (await app.activity.runCounts(), await app.activity.runs()),
        builder: (context, data) {
          final (counts, runs) = data;
          final total = counts.values.fold(0, (a, b) => a + b);
          return ListView(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
            children: [
              Row(
                children: [
                  _Stat(value: total, label: 'Syncs', color: Palette.ink),
                  const SizedBox(width: 10),
                  _Stat(
                    value: counts[SyncOutcome.done] ?? 0,
                    label: 'Done',
                    color: Palette.teal,
                  ),
                  const SizedBox(width: 10),
                  _Stat(
                    value: counts[SyncOutcome.merged] ?? 0,
                    label: 'Merged',
                    color: Palette.amberDot,
                  ),
                  const SizedBox(width: 10),
                  _Stat(
                    value: counts[SyncOutcome.failed] ?? 0,
                    label: 'Failed',
                    color: Palette.redStrong,
                  ),
                ],
              ),
              const SectionTitle('Recent syncs'),
              if (runs.isEmpty)
                const EmptyState(icon: Icons.history, message: 'No syncs yet.'),
              for (final r in runs) ...[
                RecordCard(
                  title: switch (r.outcome) {
                    SyncOutcome.done => 'Sync complete',
                    SyncOutcome.merged => 'Sync with a merge',
                    SyncOutcome.failed => 'Sync failed',
                  },
                  subtitle: r.detail,
                  trailingTop: shortWhen(r.finishedAt),
                  trailingBottom: switch (r.outcome) {
                    SyncOutcome.done => const Tag.teal('Done'),
                    SyncOutcome.merged => const Tag.amber('Merged'),
                    SyncOutcome.failed => const Tag.red('Failed'),
                  },
                ),
                const SizedBox(height: 12),
              ],
            ],
          );
        },
      ),
    );
  }
}

class _Stat extends StatelessWidget {
  const _Stat({required this.value, required this.label, required this.color});

  final int value;
  final String label;
  final Color color;

  @override
  Widget build(BuildContext context) {
    return Expanded(
      child: Card(
        child: Padding(
          padding: const EdgeInsets.symmetric(vertical: 18),
          child: Column(
            children: [
              FittedBox(
                child: Text(
                  '$value',
                  style: TextStyle(
                    color: color,
                    fontSize: 32,
                    fontWeight: FontWeight.w800,
                  ),
                ),
              ),
              const SizedBox(height: 4),
              Text(label, style: Theme.of(context).textTheme.bodyMedium),
            ],
          ),
        ),
      ),
    );
  }
}
