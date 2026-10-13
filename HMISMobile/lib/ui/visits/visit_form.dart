import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/models.dart';
import '../../core/repositories.dart';
import '../../core/schema.dart';
import '../app_scope.dart';
import '../theme.dart';
import '../widgets.dart';
import 'patient_picker.dart';

/// Records a new visit, or edits, deletes or restores [visit].
class VisitForm extends StatefulWidget {
  const VisitForm({super.key, this.visit, this.patientId});

  final Visit? visit;

  /// Preselected patient for a new visit.
  final String? patientId;

  @override
  State<VisitForm> createState() => _VisitFormState();
}

class _VisitFormState extends State<VisitForm> {
  final _formKey = GlobalKey<FormState>();
  late final TextEditingController _reason;
  late final Map<String, TextEditingController> _vitals;
  String? _patientId;
  String? _patientName;
  late String _visitType;
  late DateTime _time;
  bool _saving = false;

  Visit? get _visit => widget.visit;
  bool get _isEdit => _visit != null;

  @override
  void initState() {
    super.initState();
    final v = _visit;
    _reason = TextEditingController(text: v?.reason);
    _vitals = {
      for (final f in vitalFields)
        f.key: TextEditingController(text: v?.vitals[f.key]),
    };
    _patientId = v?.patientId ?? widget.patientId;
    _patientName = v?.patientName;
    _visitType = v?.visitType ?? VisitType.outpatient.key;
    _time = v?.time ?? DateTime.now();
    if (_patientId != null && _patientName == null) _loadPatientName();
  }

  Future<void> _loadPatientName() async {
    final p = await AppScope.read(context).patients.get(_patientId!);
    if (mounted) setState(() => _patientName = p?.name);
  }

  @override
  void dispose() {
    _reason.dispose();
    for (final c in _vitals.values) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _pickPatient() async {
    final patient = await pickPatient(context);
    if (patient != null) {
      setState(() {
        _patientId = patient.id;
        _patientName = patient.name;
      });
    }
  }

  Future<void> _pickTime() async {
    final date = await showDatePicker(
      context: context,
      initialDate: _time,
      firstDate: DateTime(2000),
      lastDate: DateTime.now().add(const Duration(days: 365)),
    );
    if (date == null || !mounted) return;
    final time = await showTimePicker(
      context: context,
      initialTime: TimeOfDay.fromDateTime(_time),
    );
    if (time == null) return;
    setState(
      () => _time = DateTime(
        date.year,
        date.month,
        date.day,
        time.hour,
        time.minute,
      ),
    );
  }

  Future<void> _save() async {
    if (_patientId == null) {
      showError(context, StateError('Choose a patient.'));
      return;
    }
    if (!_formKey.currentState!.validate()) return;
    setState(() => _saving = true);
    final app = AppScope.of(context);
    final input = VisitInput(
      visitType: _visitType,
      time: _time,
      reason: _reason.text,
      vitals: {for (final e in _vitals.entries) e.key: e.value.text.trim()},
    );
    try {
      if (_isEdit) {
        await app.visits.update(_visit!, input);
      } else {
        await app.visits.create(_patientId!, input);
      }
      if (mounted) Navigator.of(context).pop();
    } on Object catch (e) {
      if (!mounted) return;
      setState(() => _saving = false);
      showError(context, e);
    }
  }

  Future<void> _delete() async {
    final ok = await confirm(
      context,
      title: 'Delete this visit?',
      message:
          'It will be hidden on every device after the next sync. '
          'You can restore it from the patient’s page.',
      action: 'Delete',
    );
    if (!ok || !mounted) return;
    try {
      await AppScope.of(context).visits.delete(_visit!);
      if (mounted) Navigator.of(context).pop();
    } on Object catch (e) {
      if (mounted) showError(context, e);
    }
  }

  Future<void> _restore() async {
    try {
      await AppScope.of(context).visits.restore(_visit!);
      if (mounted) Navigator.of(context).pop();
    } on Object catch (e) {
      if (mounted) showError(context, e);
    }
  }

  @override
  Widget build(BuildContext context) {
    final deleted = _visit?.isDeleted ?? false;
    return Scaffold(
      appBar: FieldAppBar(
        title: _isEdit ? 'Visit' : 'Record visit',
        actions: [
          if (_isEdit && !deleted)
            IconButton(
              tooltip: 'Delete visit',
              icon: const Icon(Icons.delete_outline),
              onPressed: _delete,
            ),
        ],
      ),
      body: Form(
        key: _formKey,
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 16, 16, 32),
          children: [
            if (deleted) ...[
              _DeletedBanner(onRestore: _restore),
              const SizedBox(height: 16),
            ],
            _Label('Patient'),
            Card(
              clipBehavior: Clip.antiAlias,
              child: ListTile(
                contentPadding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 6,
                ),
                leading: _patientName == null ? null : Avatar(_patientName!),
                title: Text(
                  _patientName ?? 'Choose a patient',
                  style: Theme.of(context).textTheme.titleMedium?.copyWith(
                    color: _patientName == null ? Palette.muted : Palette.ink,
                  ),
                ),
                // A visit lives inside its patient's document and cannot move.
                trailing: _isEdit ? null : const Icon(Icons.chevron_right),
                onTap: _isEdit ? null : _pickPatient,
              ),
            ),
            _Label('Visit type'),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              children: [
                for (final t in VisitType.values)
                  ChoiceChip(
                    label: Text(t.label),
                    selected: _visitType == t.key,
                    onSelected: deleted
                        ? null
                        : (_) => setState(() => _visitType = t.key),
                  ),
              ],
            ),
            _Label('Date and time'),
            Card(
              clipBehavior: Clip.antiAlias,
              child: ListTile(
                leading: const Icon(Icons.schedule, color: Palette.teal),
                title: Text(dateTimeFormat.format(_time)),
                trailing: const Icon(Icons.edit_calendar_outlined),
                onTap: deleted ? null : _pickTime,
              ),
            ),
            _Label('Reason'),
            TextFormField(
              controller: _reason,
              enabled: !deleted,
              maxLength: reasonMaxLength,
              textCapitalization: TextCapitalization.sentences,
              decoration: const InputDecoration(
                hintText: 'e.g. Antenatal check, Malaria test',
              ),
            ),
            _Label('Vitals'),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: LayoutBuilder(
                  builder: (context, box) {
                    final width = (box.maxWidth - 12) / 2;
                    return Wrap(
                      spacing: 12,
                      runSpacing: 14,
                      children: [
                        for (final f in vitalFields)
                          SizedBox(
                            width: width,
                            child: _vitalInput(f, enabled: !deleted),
                          ),
                      ],
                    );
                  },
                ),
              ),
            ),
            const SizedBox(height: 24),
            if (!deleted)
              FilledButton(
                onPressed: _saving ? null : _save,
                child: Text(_isEdit ? 'Save changes' : 'Record visit'),
              ),
          ],
        ),
      ),
    );
  }

  Widget _vitalInput(VitalField f, {required bool enabled}) {
    return TextFormField(
      controller: _vitals[f.key],
      enabled: enabled,
      keyboardType: TextInputType.numberWithOptions(decimal: f.decimals > 0),
      inputFormatters: [FilteringTextInputFormatter.allow(RegExp(r'[0-9.]'))],
      decoration: InputDecoration(
        labelText: f.label,
        suffixText: f.unit,
        isDense: true,
        errorMaxLines: 2,
      ),
      validator: (v) => f.validate(v ?? ''),
    );
  }
}

class _Label extends StatelessWidget {
  const _Label(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(4, 18, 4, 8),
    child: Text(text, style: Theme.of(context).textTheme.titleMedium),
  );
}

class _DeletedBanner extends StatelessWidget {
  const _DeletedBanner({required this.onRestore});

  final VoidCallback onRestore;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(18),
      decoration: BoxDecoration(
        color: Palette.redSoft,
        borderRadius: BorderRadius.circular(18),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text(
            'This visit was deleted',
            style: TextStyle(
              color: Palette.red,
              fontWeight: FontWeight.w800,
              fontSize: 17,
            ),
          ),
          const SizedBox(height: 4),
          const Text(
            'It is hidden from lists. Restore it to show it again on every device.',
            style: TextStyle(color: Palette.ink),
          ),
          const SizedBox(height: 12),
          OutlinedButton(
            onPressed: onRestore,
            child: const Text('Restore visit'),
          ),
        ],
      ),
    );
  }
}
