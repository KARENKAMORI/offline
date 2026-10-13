import 'package:flutter/material.dart';

import '../../core/identity.dart';
import '../../core/models.dart';
import '../../core/repositories.dart';
import '../../core/schema.dart';
import '../app_scope.dart';
import '../widgets.dart';
import 'patient_detail.dart';

/// Registers a patient, or edits [patient].
class PatientForm extends StatefulWidget {
  const PatientForm({super.key, this.patient});

  final Patient? patient;

  @override
  State<PatientForm> createState() => _PatientFormState();
}

class _PatientFormState extends State<PatientForm> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _name;
  late final TextEditingController _phone;
  late final TextEditingController _location;
  late String _status;
  late bool _head;
  bool _saving = false;

  bool get _isEdit => widget.patient != null;

  @override
  void initState() {
    super.initState();
    final p = widget.patient;
    _name = TextEditingController(text: p?.name);
    _phone = TextEditingController(text: p?.phone);
    _location = TextEditingController(text: p?.location);
    _status = p?.status ?? PatientStatus.active.name;
    _head = p?.headOfHousehold ?? false;
  }

  @override
  void dispose() {
    _name.dispose();
    _phone.dispose();
    _location.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (!_formKey.currentState!.validate()) return;
    setState(() => _saving = true);
    final app = AppScope.of(context);
    final input = PatientInput(
      name: _name.text,
      phone: _phone.text,
      status: _status,
      location: _location.text,
      headOfHousehold: _head,
    );
    try {
      if (_isEdit) {
        await app.patients.update(widget.patient!.id, input);
      } else {
        if (!await _checkPhone(app, input)) return;
        await app.patients.create(input);
      }
      if (mounted) Navigator.of(context).pop();
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _saving = false);
      showError(context, e);
    }
  }

  /// Warns when patients on this phone already use the number. Returns
  /// whether to go on registering; false once it has handled the outcome.
  Future<bool> _checkPhone(AppServices app, PatientInput input) async {
    final others = await app.patients.withPhone(input.phone);
    if (others.isEmpty || !mounted) return true;
    final name = normalizeName(input.name);
    final same = others.where((p) => normalizeName(p.name) == name);
    final String? choice;
    if (same.isNotEmpty) {
      final existing = same.first;
      choice = await showDialog<String>(
        context: context,
        builder: (context) => AlertDialog(
          content: Text(
            '${existing.name} (${existing.phone}) is already registered.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, 'open'),
              child: const Text('Open existing'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context, 'register'),
              child: const Text('Register anyway'),
            ),
          ],
        ),
      );
      if (choice == 'open' && mounted) {
        Navigator.of(context).pushReplacement(
          MaterialPageRoute<void>(
            builder: (_) => PatientDetail(patientId: existing.id),
          ),
        );
      }
    } else {
      choice = await showDialog<String>(
        context: context,
        builder: (context) => AlertDialog(
          content: Text(
            'This number is also used by ${_names(others.map((p) => p.name))}.',
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, 'register'),
              child: const Text('Continue'),
            ),
          ],
        ),
      );
    }
    if (choice == 'register') return true;
    // Dismissed: stay on the form.
    if (choice != 'open' && mounted) setState(() => _saving = false);
    return false;
  }

  @override
  Widget build(BuildContext context) {
    // A synced value outside the known statuses stays selectable so saving
    // other fields doesn't silently change it.
    final statuses = [
      for (final s in PatientStatus.values) (s.name, s.label),
      if (PatientStatus.tryParse(_status) == null) (_status, _status),
    ];
    return Scaffold(
      appBar: FieldAppBar(title: _isEdit ? 'Edit patient' : 'Register patient'),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 20, 16, 32),
          children: [
            TextFormField(
              controller: _name,
              textCapitalization: TextCapitalization.words,
              textInputAction: TextInputAction.next,
              maxLength: 200,
              decoration: const InputDecoration(
                labelText: 'Full name',
                prefixIcon: Icon(Icons.person),
              ),
              validator: (v) =>
                  (v ?? '').trim().isEmpty ? 'Enter the patient’s name' : null,
            ),
            const SizedBox(height: 8),
            TextFormField(
              controller: _phone,
              keyboardType: TextInputType.phone,
              textInputAction: TextInputAction.next,
              decoration: const InputDecoration(
                labelText: 'Phone (optional)',
                hintText: 'e.g. 0712 345678',
                prefixIcon: Icon(Icons.phone),
              ),
              validator: (v) {
                final value = normalizePhone(v ?? '');
                if (value.isEmpty) return null;
                // The server stores at most 20 characters.
                return RegExp(r'^\+?[0-9]{7,15}$').hasMatch(value)
                    ? null
                    : 'Enter a valid phone number';
              },
            ),
            const SizedBox(height: 16),
            TextFormField(
              controller: _location,
              textCapitalization: TextCapitalization.words,
              maxLength: 200,
              decoration: const InputDecoration(
                labelText: 'Location',
                hintText: 'Village, ward or estate',
                prefixIcon: Icon(Icons.place),
              ),
              // The server cannot create a patient without a location.
              validator: (v) => (v ?? '').trim().isEmpty
                  ? 'Enter where the patient lives'
                  : null,
            ),
            const SizedBox(height: 8),
            Text('Status', style: Theme.of(context).textTheme.titleMedium),
            const SizedBox(height: 8),
            SegmentedButton<String>(
              segments: [
                for (final (value, label) in statuses)
                  ButtonSegment(value: value, label: Text(label)),
              ],
              selected: {_status},
              onSelectionChanged: (s) => setState(() => _status = s.single),
            ),
            const SizedBox(height: 16),
            Card(
              child: SwitchListTile(
                title: const Text(
                  'Head of household',
                  style: TextStyle(fontWeight: FontWeight.w700),
                ),
                subtitle: const Text('This patient heads their household'),
                value: _head,
                onChanged: (v) => setState(() => _head = v),
              ),
            ),
            const SizedBox(height: 24),
            FilledButton(
              onPressed: _saving ? null : _save,
              child: Text(_isEdit ? 'Save changes' : 'Register patient'),
            ),
          ],
        ),
      ),
    );
  }
}

/// "Amina", "Amina and Juma", "Amina, Juma and Wanjiru".
String _names(Iterable<String> names) {
  final list = names.toSet().toList();
  return list.length == 1
      ? list.single
      : '${list.sublist(0, list.length - 1).join(', ')} and ${list.last}';
}
