import 'package:flutter/material.dart';

import '../app_scope.dart';
import '../theme.dart';
import '../widgets.dart';

/// Who uses this phone, its name on other devices, and the server address.
class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key});

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  final _formKey = GlobalKey<FormState>();
  TextEditingController? _name;
  late TextEditingController _area;
  late TextEditingController _device;
  late TextEditingController _server;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    if (_name != null) return;
    final p = AppScope.of(context).profile;
    _name = TextEditingController(text: p.workerName);
    _area = TextEditingController(text: p.area);
    _device = TextEditingController(text: p.deviceName);
    _server = TextEditingController(text: p.serverUrl);
  }

  @override
  void dispose() {
    for (final c in [_name, _area, _device, _server]) {
      c?.dispose();
    }
    super.dispose();
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;
    final app = AppScope.of(context);
    await app.profile.save(
      workerName: _name!.text,
      area: _area.text,
      deviceName: _device.text,
      serverUrl: _server.text,
    );
    if (!mounted) return;
    FocusScope.of(context).unfocus();
    ScaffoldMessenger.of(context)
        .showSnackBar(const SnackBar(content: Text('Profile saved')));
    app.sync.syncNow();
  }

  @override
  Widget build(BuildContext context) {
    final profile = AppScope.of(context).profile;
    return Scaffold(
      appBar: const FieldAppBar(title: 'Profile'),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 20, 16, 32),
          children: [
            TextFormField(
              controller: _name,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(
                labelText: 'Your name',
                hintText: 'e.g. Nurse Wairimu',
                prefixIcon: Icon(Icons.badge_outlined),
              ),
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: _area,
              textCapitalization: TextCapitalization.words,
              decoration: const InputDecoration(
                labelText: 'Area',
                hintText: 'e.g. Kinangop sub-county',
                prefixIcon: Icon(Icons.map_outlined),
              ),
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: _device,
              decoration: const InputDecoration(
                labelText: 'Device name',
                helperText:
                    'Shown on other devices when your edits meet theirs.',
                prefixIcon: Icon(Icons.phone_android),
              ),
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: _server,
              keyboardType: TextInputType.url,
              decoration: const InputDecoration(
                labelText: 'Server address',
                helperText:
                    'Default https://offline-hmis.vercel.app. The emulator reaches this computer at http://10.0.2.2:8000',
                prefixIcon: Icon(Icons.dns_outlined),
              ),
              validator: (v) {
                final uri = Uri.tryParse((v ?? '').trim());
                return uri != null && uri.hasScheme && uri.host.isNotEmpty
                    ? null
                    : 'Enter an address like http://192.168.1.10:8000';
              },
            ),
            const SizedBox(height: 24),
            FilledButton(onPressed: _save, child: const Text('Save')),
            const SizedBox(height: 16),
            Text(
              'Device ID ${profile.deviceId}',
              textAlign: TextAlign.center,
              style: const TextStyle(color: Palette.muted, fontSize: 12),
            ),
            const SizedBox(height: 8),
            const PillLegend(),
          ],
        ),
      ),
    );
  }
}
