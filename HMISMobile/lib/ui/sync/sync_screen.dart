import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../../core/sync_service.dart';
import '../app_scope.dart';
import '../theme.dart';
import '../widgets.dart';
import 'pending_changes_screen.dart';
import 'sync_history_screen.dart';

class SyncScreen extends StatelessWidget {
  const SyncScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    return Scaffold(
      appBar: const FieldAppBar(title: 'Sync'),
      body: ListenableBuilder(
        listenable: app.sync,
        builder: (context, _) => LiveQuery<_Data>(
          load: (app) async => _Data(
            await app.store.pendingChanges(),
            await app.activity.runCounts(),
            await app.activity.problemCount(),
          ),
          builder: (context, data) => _SyncView(data: data),
        ),
      ),
    );
  }
}

class _Data {
  const _Data(this.pending, this.counts, this.problems);

  final List<PendingChange> pending;
  final Map<SyncOutcome, int> counts;
  final int problems;
}

class _SyncView extends StatelessWidget {
  const _SyncView({required this.data});

  final _Data data;

  @override
  Widget build(BuildContext context) {
    final sync = AppScope.of(context).sync;
    final syncing = sync.connection == Connection.syncing;
    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
      children: [
        PendingSummary(pending: data.pending, lastSynced: sync.lastSyncedAt),
        if (sync.lastError != null) ...[
          const SizedBox(height: 12),
          Text(
            sync.lastError!,
            style: const TextStyle(
              color: Palette.red,
              fontWeight: FontWeight.w700,
            ),
          ),
        ],
        const SizedBox(height: 16),
        FilledButton(
          onPressed: syncing ? null : sync.syncNow,
          child: Text(syncing ? 'Syncing…' : 'Sync now'),
        ),
        const SizedBox(height: 8),
        Center(
          child: Text(
            "Sync starts on its own when you're back online.",
            style: Theme.of(context).textTheme.bodyMedium,
          ),
        ),
        const SizedBox(height: 8),
        if (data.problems > 0) ...[
          const SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.all(16),
            decoration: BoxDecoration(
              color: Palette.redSoft,
              borderRadius: BorderRadius.circular(18),
            ),
            child: Text(
              '${data.problems} ${data.problems == 1 ? 'patient has' : 'patients have'} values the server '
              'could not save. Open the patient to see what to correct.',
              style: const TextStyle(
                color: Palette.red,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
        ],
        const SizedBox(height: 8),
        RecordCard(
          leading: const Icon(
            Icons.pending_actions,
            color: Palette.teal,
            size: 28,
          ),
          title: 'Pending changes',
          subtitle: data.pending.isEmpty
              ? 'Nothing waiting'
              : '${data.pending.length} saved on this phone',
          trailingBottom: const Icon(Icons.chevron_right),
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute<void>(
              builder: (_) => const PendingChangesScreen(),
            ),
          ),
        ),
        const SizedBox(height: 12),
        RecordCard(
          leading: const Icon(Icons.history, color: Palette.teal, size: 28),
          title: 'Sync history',
          subtitle: _historyLine(data.counts),
          trailingBottom: const Icon(Icons.chevron_right),
          onTap: () => Navigator.of(context).push(
            MaterialPageRoute<void>(builder: (_) => const SyncHistoryScreen()),
          ),
        ),
        const SizedBox(height: 8),
        const PillLegend(),
      ],
    );
  }

  static String _historyLine(Map<SyncOutcome, int> counts) {
    final total = counts.values.fold(0, (a, b) => a + b);
    if (total == 0) return 'No syncs yet';
    return '$total syncs · ${counts[SyncOutcome.failed] ?? 0} failed';
  }
}

/// Amber "N changes waiting to sync" card, or a calm one when there are none.
class PendingSummary extends StatelessWidget {
  const PendingSummary({
    super.key,
    required this.pending,
    required this.lastSynced,
  });

  final List<PendingChange> pending;
  final DateTime? lastSynced;

  @override
  Widget build(BuildContext context) {
    final waiting = pending.isNotEmpty;
    final fg = waiting ? Palette.amber : Palette.teal;
    final n = pending.length;
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: waiting ? Palette.amberSoft : Palette.tealSoft,
        borderRadius: BorderRadius.circular(18),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            waiting
                ? '$n ${n == 1 ? 'change' : 'changes'} waiting to sync'
                : 'Everything is synced',
            style: TextStyle(
              color: fg,
              fontSize: 20,
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 6),
          Text(
            waiting
                ? 'Oldest change made ${ago(pending.first.time)}'
                : lastSynced == null
                ? 'Not synced with the server yet'
                : 'Last synced ${shortWhen(lastSynced!).toLowerCase()}',
            style: TextStyle(color: fg, fontSize: 16),
          ),
        ],
      ),
    );
  }
}
