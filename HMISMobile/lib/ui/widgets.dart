import 'package:flutter/material.dart';
import 'package:intl/intl.dart';

import '../core/sync_service.dart';
import 'app_scope.dart';
import 'theme.dart';

final timeFormat = DateFormat('HH:mm');
final dayFormat = DateFormat('EEE d MMM');
final dateTimeFormat = DateFormat('d MMM yyyy, HH:mm');

/// "Today 11:58", "Mon 17:20", "3 Oct 09:15".
String shortWhen(DateTime t) {
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final day = DateTime(t.year, t.month, t.day);
  final diff = today.difference(day).inDays;
  if (diff == 0) return 'Today ${timeFormat.format(t)}';
  if (diff == 1) return 'Yesterday ${timeFormat.format(t)}';
  if (diff < 7) return DateFormat('EEE HH:mm').format(t);
  return DateFormat('d MMM HH:mm').format(t);
}

/// "2 hours ago".
String ago(DateTime t) {
  final d = DateTime.now().difference(t);
  if (d.inMinutes < 1) return 'just now';
  if (d.inMinutes < 60) return '${d.inMinutes} min ago';
  if (d.inHours < 24) {
    return '${d.inHours} ${d.inHours == 1 ? 'hour' : 'hours'} ago';
  }
  return '${d.inDays} ${d.inDays == 1 ? 'day' : 'days'} ago';
}

/// The design's header: a white bar with a title and the status pill.
class FieldAppBar extends StatelessWidget implements PreferredSizeWidget {
  const FieldAppBar({super.key, required this.title, this.actions = const []});

  final String title;
  final List<Widget> actions;

  @override
  Size get preferredSize => const Size.fromHeight(72);

  @override
  Widget build(BuildContext context) {
    return AppBar(
      toolbarHeight: 72,
      titleSpacing: Navigator.of(context).canPop() ? 0 : 24,
      leading: Navigator.of(context).canPop()
          ? IconButton(
              tooltip: 'Back',
              icon: const Icon(Icons.chevron_left, size: 32),
              onPressed: () => Navigator.of(context).maybePop(),
            )
          : null,
      title: Text(title),
      actions: [
        ...actions,
        const Padding(
          padding: EdgeInsets.only(right: 16, left: 8),
          child: StatusPill(),
        ),
      ],
    );
  }
}

({Color bg, Color fg, Color dot, String label}) pillStyle(Connection c) =>
    switch (c) {
      Connection.online => (
        bg: Palette.tealSoft,
        fg: Palette.ink,
        dot: Palette.teal,
        label: 'Online',
      ),
      Connection.offline => (
        bg: Palette.amberSoft,
        fg: Palette.amber,
        dot: Palette.amberDot,
        label: 'Offline',
      ),
      Connection.syncing => (
        bg: Palette.blueSoft,
        fg: Palette.blue,
        dot: Palette.blueDot,
        label: 'Syncing',
      ),
    };

/// Online / Offline / Syncing. Tap for what each one means.
class StatusPill extends StatelessWidget {
  const StatusPill({super.key, this.connection});

  /// Fixed state for the legend; null follows the live sync state.
  final Connection? connection;

  @override
  Widget build(BuildContext context) {
    if (connection != null) return _pill(context, connection!, false);
    final sync = AppScope.of(context).sync;
    return ListenableBuilder(
      listenable: sync,
      builder: (context, _) => _pill(context, sync.connection, true),
    );
  }

  Widget _pill(BuildContext context, Connection c, bool tappable) {
    final s = pillStyle(c);
    final pill = Container(
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 7),
      decoration: BoxDecoration(
        color: s.bg,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          CircleAvatar(radius: 6, backgroundColor: s.dot),
          const SizedBox(width: 8),
          Text(
            s.label,
            style: TextStyle(
              color: s.fg,
              fontWeight: FontWeight.w800,
              fontSize: 15,
            ),
          ),
        ],
      ),
    );
    if (!tappable) return pill;
    return Semantics(
      button: true,
      label: '${s.label}. What does this mean?',
      excludeSemantics: true,
      child: InkWell(
        borderRadius: BorderRadius.circular(20),
        onTap: () => showModalBottomSheet<void>(
          context: context,
          backgroundColor: Palette.background,
          showDragHandle: true,
          isScrollControlled: true,
          builder: (_) => const SafeArea(
            child: SingleChildScrollView(
              padding: EdgeInsets.fromLTRB(16, 0, 16, 24),
              child: PillLegend(),
            ),
          ),
        ),
        child: pill,
      ),
    );
  }
}

/// "What the status pill means", with live progress while syncing.
class PillLegend extends StatelessWidget {
  const PillLegend({super.key});

  @override
  Widget build(BuildContext context) {
    final sync = AppScope.of(context).sync;
    return ListenableBuilder(
      listenable: sync,
      builder: (context, _) => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          const SectionTitle('What the status pill means'),
          const _LegendCard(
            connection: Connection.online,
            text: 'Connected. Changes sync to the server on their own',
          ),
          const SizedBox(height: 12),
          const _LegendCard(
            connection: Connection.offline,
            text: "No connection. Changes are saved on this phone and sync when you're back online",
          ),
          const SizedBox(height: 12),
          _LegendCard(
            connection: Connection.syncing,
            text: sync.connection == Connection.syncing && sync.sending > 0
                ? 'Sending ${sync.sending} ${sync.sending == 1 ? 'change' : 'changes'} to the server'
                : 'Sending changes to the server',
            progress: sync.connection == Connection.syncing ? sync : null,
          ),
        ],
      ),
    );
  }
}

class _LegendCard extends StatelessWidget {
  const _LegendCard({
    required this.connection,
    required this.text,
    this.progress,
  });

  final Connection connection;
  final String text;
  final SyncService? progress;

  @override
  Widget build(BuildContext context) {
    final p = progress;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(18),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            StatusPill(connection: connection),
            const SizedBox(height: 10),
            Row(
              children: [
                Expanded(
                  child: Text(
                    text,
                    style: Theme.of(context).textTheme.bodyLarge
                        ?.copyWith(color: Palette.muted),
                  ),
                ),
                if (p != null && p.progressTotal > 0)
                  Text(
                    '${p.progressDone} of ${p.progressTotal}',
                    style: const TextStyle(
                      color: Palette.blue,
                      fontWeight: FontWeight.w800,
                    ),
                  ),
              ],
            ),
            if (p != null && p.progressTotal > 0) ...[
              const SizedBox(height: 12),
              ClipRRect(
                borderRadius: BorderRadius.circular(4),
                child: LinearProgressIndicator(
                  value: p.progressDone / p.progressTotal,
                  minHeight: 6,
                  color: Palette.blueDot,
                  backgroundColor: Palette.blueSoft,
                ),
              ),
            ],
          ],
        ),
      ),
    );
  }
}

class SectionTitle extends StatelessWidget {
  const SectionTitle(this.text, {super.key, this.trailing});

  final String text;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 20, 4, 12),
      child: Row(
        children: [
          Expanded(
            child: Text(text, style: Theme.of(context).textTheme.titleMedium),
          ),
          ?trailing,
        ],
      ),
    );
  }
}

class Avatar extends StatelessWidget {
  const Avatar(this.name, {super.key});

  final String name;

  @override
  Widget build(BuildContext context) {
    final letter = name.trim().isEmpty ? '?' : name.trim()[0].toUpperCase();
    return CircleAvatar(
      radius: 24,
      backgroundColor: Palette.tealSoft,
      child: Text(
        letter,
        style: const TextStyle(
          color: Palette.teal,
          fontWeight: FontWeight.w800,
          fontSize: 18,
        ),
      ),
    );
  }
}

/// "✓ Synced" or "◷ Waiting".
class SyncBadge extends StatelessWidget {
  const SyncBadge({super.key, required this.waiting});

  final bool waiting;

  @override
  Widget build(BuildContext context) {
    final color = waiting ? Palette.amberDot : Palette.teal;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(waiting ? Icons.schedule : Icons.check, size: 16, color: color),
        const SizedBox(width: 6),
        Text(
          waiting ? 'Waiting' : 'Synced',
          style: TextStyle(
            color: color,
            fontWeight: FontWeight.w800,
            fontSize: 15,
          ),
        ),
      ],
    );
  }
}

/// Small rounded label, e.g. "Done", "Merged", "Head of household".
class Tag extends StatelessWidget {
  const Tag(this.text, {super.key, required this.bg, required this.fg});

  const Tag.teal(this.text, {super.key})
    : bg = Palette.tealSoft,
      fg = Palette.teal;
  const Tag.amber(this.text, {super.key})
    : bg = Palette.amberSoft,
      fg = Palette.amber;
  const Tag.red(this.text, {super.key})
    : bg = Palette.redSoft,
      fg = Palette.red;

  final String text;
  final Color bg;
  final Color fg;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      decoration: BoxDecoration(
        color: bg,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Text(
        text,
        style: TextStyle(color: fg, fontWeight: FontWeight.w800, fontSize: 14),
      ),
    );
  }
}

/// A white card row: leading, title over subtitle, and a trailing column.
class RecordCard extends StatelessWidget {
  const RecordCard({
    super.key,
    this.leading,
    required this.title,
    this.subtitle,
    this.trailingTop,
    this.trailingBottom,
    this.onTap,
  });

  final Widget? leading;
  final String title;
  final String? subtitle;
  final String? trailingTop;
  final Widget? trailingBottom;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 16),
          child: Row(
            children: [
              if (leading != null) ...[leading!, const SizedBox(width: 14)],
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      title,
                      style: text.titleMedium,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                    if (subtitle != null && subtitle!.isNotEmpty) ...[
                      const SizedBox(height: 4),
                      Text(
                        subtitle!,
                        style: text.bodyMedium,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ],
                  ],
                ),
              ),
              if (trailingTop != null || trailingBottom != null) ...[
                const SizedBox(width: 12),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.end,
                  children: [
                    if (trailingTop != null)
                      Text(
                        trailingTop!,
                        style: text.bodyMedium?.copyWith(fontSize: 16),
                      ),
                    if (trailingTop != null && trailingBottom != null)
                      const SizedBox(height: 8),
                    ?trailingBottom,
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class EmptyState extends StatelessWidget {
  const EmptyState({super.key, required this.icon, required this.message});

  final IconData icon;
  final String message;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 40, horizontal: 24),
      child: Column(
        children: [
          Icon(icon, size: 48, color: Palette.navIdle),
          const SizedBox(height: 12),
          Text(
            message,
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.bodyMedium,
          ),
        ],
      ),
    );
  }
}

Future<bool> confirm(
  BuildContext context, {
  required String title,
  required String message,
  required String action,
}) async {
  final ok = await showDialog<bool>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context, false),
          child: const Text('Cancel'),
        ),
        TextButton(
          style: TextButton.styleFrom(foregroundColor: Palette.redStrong),
          onPressed: () => Navigator.pop(context, true),
          child: Text(action),
        ),
      ],
    ),
  );
  return ok ?? false;
}

void showError(BuildContext context, Object error) {
  final message = error is StateError ? error.message : '$error';
  ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text(message)));
}
