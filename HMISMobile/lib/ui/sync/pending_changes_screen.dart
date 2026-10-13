import 'package:flutter/material.dart';

import '../../core/models.dart';
import '../../core/sync_service.dart';
import '../app_scope.dart';
import '../theme.dart';
import '../widgets.dart';
import 'sync_screen.dart';

class PendingChangesScreen extends StatelessWidget {
  const PendingChangesScreen({super.key});

  @override
  Widget build(BuildContext context) {
    final sync = AppScope.of(context).sync;
    return Scaffold(
      appBar: const FieldAppBar(title: 'Pending changes'),
      body: ListenableBuilder(
        listenable: sync,
        builder: (context, _) => LiveQuery<List<PendingChange>>(
          load: (app) => app.store.pendingChanges(),
          builder: (context, pending) => ListView(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
            children: [
              PendingSummary(pending: pending, lastSynced: sync.lastSyncedAt),
              const SizedBox(height: 16),
              for (final c in pending) ...[
                RecordCard(
                  leading: _VerbIcon(c.verb),
                  title: switch (c.verb) {
                    ChangeVerb.added => 'Added',
                    ChangeVerb.edited => 'Edited',
                    ChangeVerb.deleted => 'Deleted',
                  },
                  subtitle: c.summary,
                  trailingTop: timeFormat.format(c.time),
                ),
                const SizedBox(height: 12),
              ],
              Padding(
                padding: const EdgeInsets.fromLTRB(4, 4, 4, 16),
                child: Text(
                  'Changes are kept on the phone, even if it restarts.',
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
              ),
              FilledButton(
                onPressed: sync.connection == Connection.syncing
                    ? null
                    : sync.syncNow,
                child: const Text('Sync now'),
              ),
              const SizedBox(height: 12),
              Center(
                child: Text(
                  "Sync starts on its own when you're back online.",
                  style: Theme.of(context).textTheme.bodyMedium,
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _VerbIcon extends StatelessWidget {
  const _VerbIcon(this.verb);

  final ChangeVerb verb;

  @override
  Widget build(BuildContext context) {
    final (color, icon) = switch (verb) {
      ChangeVerb.added => (Palette.teal, Icons.add),
      ChangeVerb.edited => (Palette.blueDot, Icons.edit_outlined),
      ChangeVerb.deleted => (Palette.redStrong, Icons.remove),
    };
    return CircleAvatar(
      radius: 24,
      backgroundColor: color,
      child: Icon(icon, color: Colors.white),
    );
  }
}
