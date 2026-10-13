import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../../core/models.dart';
import '../../core/schema.dart';
import '../../core/sync_service.dart';
import '../app_scope.dart';
import '../theme.dart';
import '../widgets.dart';
import 'all_visits_screen.dart';
import 'visit_form.dart';

/// Today at a glance: greeting, today's visits, and anything sync needs the
/// user to know about.
class VisitsHome extends StatelessWidget {
  const VisitsHome({super.key});

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    return Scaffold(
      appBar: const FieldAppBar(title: 'FieldVisit'),
      body: ListenableBuilder(
        // Rebuild for the greeting and the offline banner too.
        listenable: Listenable.merge([app.profile, app.sync]),
        builder: (context, _) => LiveQuery<_Today>(
          load: (app) async => _Today(
            visits: await app.visits.onDay(DateTime.now()),
            pending: await app.patients.pendingIds(),
            replaced: await app.activity.replacedEdits(),
            notices: await app.activity.notices(),
          ),
          builder: (context, today) => _TodayView(today: today),
        ),
      ),
    );
  }
}

class _Today {
  const _Today({
    required this.visits,
    required this.pending,
    required this.replaced,
    required this.notices,
  });

  final List<Visit> visits;
  final Set<String> pending;
  final List<ReplacedEdit> replaced;
  final List<MergeNotice> notices;
}

class _TodayView extends StatelessWidget {
  const _TodayView({required this.today});

  final _Today today;

  @override
  Widget build(BuildContext context) {
    final app = AppScope.of(context);
    final now = DateTime.now();
    final visits = today.visits;
    final waiting = visits
        .where((v) => today.pending.contains(v.patientId))
        .length;
    final next = visits.where((v) => v.time!.isAfter(now)).firstOrNull;
    final text = Theme.of(context).textTheme;

    return ListView(
      padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
      children: [
        _Greeting(name: app.profile.workerName, area: app.profile.area),
        if (app.sync.connection == Connection.offline) ...[
          _OfflineBanner(lastSynced: app.sync.lastSyncedAt),
          const SizedBox(height: 12),
        ],
        _SummaryCard(count: visits.length, waiting: waiting),
        for (final n in today.notices) ...[
          const SizedBox(height: 12),
          _MergedBanner(notice: n),
        ],
        for (final r in today.replaced) ...[
          const SizedBox(height: 12),
          _ReplacedBanner(edit: r),
        ],
        if (next != null) ...[
          const SectionTitle('Next visit'),
          _VisitCard(
            visit: next,
            waiting: today.pending.contains(next.patientId),
          ),
        ],
        SectionTitle(
          "Today's visits",
          trailing: Text('${visits.length} total', style: text.bodyMedium),
        ),
        if (visits.isEmpty)
          const EmptyState(
            icon: Icons.event_note_outlined,
            message: 'No visits recorded today.',
          ),
        for (final v in visits) ...[
          _VisitCard(visit: v, waiting: today.pending.contains(v.patientId)),
          const SizedBox(height: 12),
        ],
        const SizedBox(height: 8),
        FilledButton(
          onPressed: () => Navigator.of(context)
              .push(MaterialPageRoute<void>(builder: (_) => const VisitForm())),
          child: const Text('Record new visit'),
        ),
        const SizedBox(height: 8),
        TextButton(
          onPressed: () => Navigator.of(context).push(
            MaterialPageRoute<void>(builder: (_) => const AllVisitsScreen()),
          ),
          child: const Text('See all visits'),
        ),
      ],
    );
  }
}

class _Greeting extends StatelessWidget {
  const _Greeting({required this.name, required this.area});

  final String name;
  final String area;

  @override
  Widget build(BuildContext context) {
    final hour = DateTime.now().hour;
    final part = hour < 12 ? 'morning' : (hour < 17 ? 'afternoon' : 'evening');
    final weekday = DateFormat('EEEE').format(DateTime.now());
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 16, 4, 20),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            name.isEmpty ? 'Good $part' : 'Good $part, $name',
            style: Theme.of(context).textTheme.titleLarge
                ?.copyWith(fontSize: 22),
          ),
          const SizedBox(height: 4),
          Text(
            area.isEmpty ? weekday : '$area, $weekday',
            style: Theme.of(context).textTheme.bodyMedium
                ?.copyWith(fontSize: 16),
          ),
        ],
      ),
    );
  }
}

class _OfflineBanner extends StatelessWidget {
  const _OfflineBanner({required this.lastSynced});

  final DateTime? lastSynced;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: Palette.tealSoft,
        borderRadius: BorderRadius.circular(18),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'Loaded from this phone',
            style: TextStyle(
              color: Palette.teal,
              fontWeight: FontWeight.w800,
              fontSize: 17,
            ),
          ),
          const SizedBox(height: 4),
          Text(
            lastSynced == null
                ? 'Not synced with the server yet'
                : 'Last synced with the server ${_when(lastSynced!)}',
            style: const TextStyle(color: Palette.ink, fontSize: 15),
          ),
        ],
      ),
    );
  }

  static String _when(DateTime t) {
    final now = DateTime.now();
    final sameDay =
        t.year == now.year && t.month == now.month && t.day == now.day;
    return sameDay
        ? 'at ${timeFormat.format(t)}'
        : 'on ${dateTimeFormat.format(t)}';
  }
}

class _SummaryCard extends StatelessWidget {
  const _SummaryCard({required this.count, required this.waiting});

  final int count;
  final int waiting;

  @override
  Widget build(BuildContext context) {
    const body = TextStyle(color: Color(0xFFD5E3E1), fontSize: 16, height: 1.5);
    return Container(
      padding: const EdgeInsets.fromLTRB(24, 22, 24, 22),
      decoration: BoxDecoration(
        color: Palette.ink,
        borderRadius: BorderRadius.circular(22),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            '$count ${count == 1 ? 'visit' : 'visits'} today',
            style: const TextStyle(
              color: Colors.white,
              fontSize: 28,
              fontWeight: FontWeight.w800,
            ),
          ),
          const SizedBox(height: 8),
          if (waiting > 0) ...[
            Text('$waiting saved on this phone, waiting to sync', style: body),
            const Text('Keep working. Nothing is lost.', style: body),
          ] else if (count > 0)
            const Text('All saved to the server.', style: body)
          else
            const Text(
              'Visits you record are saved on this phone first.',
              style: body,
            ),
        ],
      ),
    );
  }
}

class _MergedBanner extends StatelessWidget {
  const _MergedBanner({required this.notice});

  final MergeNotice notice;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.fromLTRB(20, 16, 8, 18),
      decoration: BoxDecoration(
        color: Palette.ink,
        borderRadius: BorderRadius.circular(18),
      ),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  notice.title,
                  style: const TextStyle(
                    color: Colors.white,
                    fontWeight: FontWeight.w800,
                    fontSize: 17,
                  ),
                ),
                const SizedBox(height: 6),
                Text(
                  notice.body,
                  style: const TextStyle(
                    color: Color(0xFFD5E3E1),
                    fontSize: 15,
                  ),
                ),
              ],
            ),
          ),
          IconButton(
            tooltip: 'Dismiss',
            icon: const Icon(Icons.close, color: Colors.white),
            onPressed: () =>
                AppScope.of(context).activity.dismissNotice(notice.id),
          ),
        ],
      ),
    );
  }
}

class _ReplacedBanner extends StatefulWidget {
  const _ReplacedBanner({required this.edit});

  final ReplacedEdit edit;

  @override
  State<_ReplacedBanner> createState() => _ReplacedBannerState();
}

class _ReplacedBannerState extends State<_ReplacedBanner> {
  bool _busy = false;

  Future<void> _resolve(bool keepMine) async {
    setState(() => _busy = true);
    try {
      await AppScope.of(context).activity
          .resolve(widget.edit, keepMine: keepMine);
    } on Object catch (e) {
      if (mounted) showError(context, e);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final e = widget.edit;
    final field = fieldLabel(e.key);
    return Container(
      padding: const EdgeInsets.all(20),
      decoration: BoxDecoration(
        color: Palette.redSoft,
        borderRadius: BorderRadius.circular(18),
        border: Border.all(color: Palette.redStrong),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(
            children: [
              Icon(Icons.warning_amber_rounded, color: Palette.red),
              SizedBox(width: 8),
              Expanded(
                child: Text(
                  'One of your edits was replaced',
                  style: TextStyle(
                    color: Palette.red,
                    fontWeight: FontWeight.w800,
                    fontSize: 18,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            "You changed ${e.patientName}'s $field to ${displayValue(e.key, e.mine)}. "
            'An edit from ${e.keptBy} at the same time set it to '
            '${displayValue(e.key, e.kept)}, so that value was kept.',
            style: const TextStyle(
              color: Palette.ink,
              fontSize: 16,
              height: 1.45,
            ),
          ),
          const SizedBox(height: 16),
          Row(
            children: [
              Expanded(
                child: FilledButton(
                  style: FilledButton.styleFrom(
                    backgroundColor: Palette.redStrong,
                    minimumSize: const Size.fromHeight(52),
                    textStyle: const TextStyle(
                      fontSize: 16,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
                  onPressed: _busy ? null : () => _resolve(true),
                  child: const Text('Re-enter mine'),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: OutlinedButton(
                  style: OutlinedButton.styleFrom(
                    foregroundColor: Palette.red,
                    backgroundColor: Palette.surface,
                    side: const BorderSide(color: Palette.redStrong),
                  ),
                  onPressed: _busy ? null : () => _resolve(false),
                  child: const Text('Keep newer'),
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

class _VisitCard extends StatelessWidget {
  const _VisitCard({required this.visit, required this.waiting});

  final Visit visit;
  final bool waiting;

  @override
  Widget build(BuildContext context) {
    final name = visit.patientName ?? 'Unknown patient';
    return RecordCard(
      leading: Avatar(name),
      title: name,
      subtitle: visit.title,
      trailingTop: visit.time == null ? null : timeFormat.format(visit.time!),
      trailingBottom: SyncBadge(waiting: waiting),
      onTap: () => Navigator.of(
        context,
      ).push(MaterialPageRoute<void>(builder: (_) => VisitForm(visit: visit))),
    );
  }
}
