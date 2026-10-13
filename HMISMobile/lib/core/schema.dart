/// Field names and allowed values of the patient document, shared with the
/// HMIS server and HMISWeb. See HMIS/DOCUMENT_SCHEMA.md; keep in step with
/// HMIS/patients/models.py.
library;

enum PatientStatus {
  active('Active'),
  inactive('Inactive'),
  suspended('Suspended');

  const PatientStatus(this.label);
  final String label;

  /// A synced value may be outside this enum if another device wrote one the
  /// server rejects, so unknown values are kept as raw strings by callers.
  static PatientStatus? tryParse(String value) =>
      values.where((s) => s.name == value).firstOrNull;
}

enum VisitType {
  outpatient('outpatient', 'Outpatient'),
  inpatient('inpatient', 'Inpatient'),
  followUp('follow_up', 'Follow-up'),
  homeVisit('home_visit', 'Home visit');

  const VisitType(this.key, this.label);

  /// Value stored in the document.
  final String key;
  final String label;

  static VisitType? tryParse(String value) =>
      values.where((t) => t.key == value).firstOrNull;

  static String labelFor(String key) => tryParse(key)?.label ?? key;
}

const reasonMaxLength = 200;

/// A vital sign stored as a decimal string on the visit map.
class VitalField {
  const VitalField({
    required this.key,
    required this.label,
    required this.unit,
    required this.min,
    required this.max,
    required this.decimals,
  });

  /// Key in the visit map.
  final String key;
  final String label;
  final String unit;
  final double min;
  final double max;

  /// 0 for whole numbers, 1 for one decimal place.
  final int decimals;

  /// Null when [value] is empty or valid, otherwise a message for the form.
  String? validate(String value) {
    final v = value.trim();
    if (v.isEmpty) return null;
    final pattern = decimals == 0 ? RegExp(r'^\d+$') : RegExp(r'^\d+(\.\d)?$');
    final number = double.tryParse(v);
    if (!pattern.hasMatch(v) || number == null) {
      return decimals == 0 ? 'Whole number' : 'Number, one decimal place';
    }
    if (number < min || number > max) {
      return '${_fmt(min)} to ${_fmt(max)}';
    }
    return null;
  }

  String _fmt(double n) => decimals == 0 ? n.toStringAsFixed(0) : '$n';
}

const vitalFields = <VitalField>[
  VitalField(
    key: 'temperature_c',
    label: 'Temperature',
    unit: '°C',
    min: 30,
    max: 45,
    decimals: 1,
  ),
  VitalField(
    key: 'pulse_bpm',
    label: 'Pulse',
    unit: 'bpm',
    min: 20,
    max: 250,
    decimals: 0,
  ),
  VitalField(
    key: 'systolic_mmhg',
    label: 'Systolic BP',
    unit: 'mmHg',
    min: 50,
    max: 260,
    decimals: 0,
  ),
  VitalField(
    key: 'diastolic_mmhg',
    label: 'Diastolic BP',
    unit: 'mmHg',
    min: 30,
    max: 160,
    decimals: 0,
  ),
  VitalField(
    key: 'respiratory_rate',
    label: 'Respiratory rate',
    unit: '/min',
    min: 5,
    max: 80,
    decimals: 0,
  ),
  VitalField(
    key: 'spo2_pct',
    label: 'SpO₂',
    unit: '%',
    min: 50,
    max: 100,
    decimals: 0,
  ),
  VitalField(
    key: 'weight_kg',
    label: 'Weight',
    unit: 'kg',
    min: 0.5,
    max: 400,
    decimals: 1,
  ),
];

final vitalKeys = {for (final f in vitalFields) f.key};

/// Human labels for every document key, used in conflict banners.
String fieldLabel(String key) => switch (key) {
  'name' => 'name',
  'phone' => 'phone number',
  'status' => 'status',
  'location' => 'location',
  'head_of_household' => 'head of household',
  'registered_at' => 'registration time',
  'visit_type' => 'visit type',
  'timestamp' => 'visit time',
  'reason' => 'visit reason',
  'deleted_at' => 'deleted visit',
  _ =>
    vitalFields.where((f) => f.key == key).firstOrNull?.label.toLowerCase() ??
        key,
};

/// A stored value as a person would read it, e.g. "38.4 °C".
String displayValue(String key, String value) {
  if (value.isEmpty) return 'blank';
  final vital = vitalFields.where((f) => f.key == key).firstOrNull;
  if (vital != null) return '$value ${vital.unit}';
  if (key == 'visit_type') return VisitType.labelFor(value);
  if (key == 'status') return PatientStatus.tryParse(value)?.label ?? value;
  return value;
}
