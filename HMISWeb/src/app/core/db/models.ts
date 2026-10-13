/** Values the HMIS server accepts. Keep in step with HMIS/patients/models.py. */
export type PatientStatus = 'active' | 'inactive' | 'suspended';
export const PATIENT_STATUSES: readonly PatientStatus[] = ['active', 'inactive', 'suspended'];

export type VisitType = 'outpatient' | 'inpatient' | 'follow_up' | 'home_visit';
export const VISIT_TYPES: readonly VisitType[] = ['outpatient', 'inpatient', 'follow_up', 'home_visit'];
export const VISIT_TYPE_LABELS: Record<VisitType, string> = {
  outpatient: 'Outpatient',
  inpatient: 'Inpatient',
  follow_up: 'Follow-up',
  home_visit: 'Home visit',
};

/** Read model, projected from the patient's Automerge document. Never written directly. */
export interface Patient {
  /** Patient UUID; also the Automerge document id. */
  id: string;
  name: string;
  phone: string;
  /** A synced value may fall outside PatientStatus if another device wrote one the server rejects. */
  status: PatientStatus | string;
  location: string;
  headOfHousehold: boolean;
  registeredAt: string;
  /**
   * Id of the patient the server merged this duplicate into, '' when not merged. Merged patients
   * are hidden from lists and open the merged_into patient instead (HMIS/DOCUMENT_SCHEMA.md).
   */
  mergedInto: string;
}

/** Vital signs recorded on a visit. Stored as decimal strings; '' means not recorded. */
export interface Vitals {
  temperatureC: string;
  pulseBpm: string;
  systolicMmhg: string;
  diastolicMmhg: string;
  respiratoryRate: string;
  spo2Pct: string;
  weightKg: string;
}
export type VitalKey = keyof Vitals;

export interface VitalField {
  key: VitalKey;
  /** Key in the visit map of the Automerge document (HMIS/DOCUMENT_SCHEMA.md). */
  docKey: string;
  label: string;
  unit: string;
  min: number;
  max: number;
  /** Decimal places allowed: 0 for whole numbers, 1 for one decimal place. */
  decimals: 0 | 1;
}

/** Ranges match the server's validators. Keep in step with HMIS/DOCUMENT_SCHEMA.md. */
export const VITAL_FIELDS: readonly VitalField[] = [
  {
    key: 'temperatureC', docKey: 'temperature_c', label: 'Temperature',
    unit: '°C', min: 30, max: 45, decimals: 1,
  },
  {
    key: 'pulseBpm', docKey: 'pulse_bpm', label: 'Pulse',
    unit: 'bpm', min: 20, max: 250, decimals: 0,
  },
  {
    key: 'systolicMmhg', docKey: 'systolic_mmhg', label: 'Systolic BP',
    unit: 'mmHg', min: 50, max: 260, decimals: 0,
  },
  {
    key: 'diastolicMmhg', docKey: 'diastolic_mmhg', label: 'Diastolic BP',
    unit: 'mmHg', min: 30, max: 160, decimals: 0,
  },
  {
    key: 'respiratoryRate', docKey: 'respiratory_rate', label: 'Respiratory rate',
    unit: 'breaths/min', min: 5, max: 80, decimals: 0,
  },
  {
    key: 'spo2Pct', docKey: 'spo2_pct', label: 'SpO₂',
    unit: '%', min: 50, max: 100, decimals: 0,
  },
  {
    key: 'weightKg', docKey: 'weight_kg', label: 'Weight',
    unit: 'kg', min: 0.5, max: 400, decimals: 1,
  },
];

export const REASON_MAX_LENGTH = 200;

export const EMPTY_VITALS: Vitals = {
  temperatureC: '',
  pulseBpm: '',
  systolicMmhg: '',
  diastolicMmhg: '',
  respiratoryRate: '',
  spo2Pct: '',
  weightKg: '',
};

/** Returns an error message for a vital value, or null when it is empty or valid. */
export function vitalError(field: VitalField, value: string): string | null {
  const v = value.trim();
  if (!v) return null;
  const pattern = field.decimals ? /^\d+(\.\d)?$/ : /^\d+$/;
  const n = Number(v);
  if (!pattern.test(v) || n < field.min || n > field.max) {
    const step = field.decimals ? ' (one decimal place)' : ' (whole number)';
    return `${field.label} must be ${field.min} to ${field.max} ${field.unit}${step}.`;
  }
  return null;
}

export interface Visit extends Vitals {
  /** Visit UUID; the key in the document's visits map. */
  id: string;
  patientId: string;
  visitType: VisitType | string;
  /** ISO 8601. */
  timestamp: string;
  /** Free text, '' when not recorded. */
  reason: string;
  /** ISO 8601 when the visit was deleted, '' otherwise. Deleted visits stay in the document. */
  deletedAt: string;
}

export type PatientInput = Pick<Patient, 'name' | 'phone' | 'location' | 'headOfHousehold'> & {
  status: PatientStatus;
};
export type VisitInput = Vitals & { visitType: VisitType; timestamp: string; reason: string };

/** A field where this device's edit lost to a concurrent edit on another device. */
export interface ReplacedEdit {
  patientId: string;
  /** "patient" or "visits/<visit id>". */
  path: string;
  key: string;
  mine: string;
  kept: string;
  /** Device name that wrote `kept`, or "the server". */
  keptBy: string;
}

/** "Merged a change from ..." banner. */
export interface MergeNotice {
  id?: number;
  patientId: string;
  title: string;
  body: string;
  createdAt: string;
  /** 0 or 1, so it can be indexed. */
  dismissed: number;
}

export type SyncOutcome = 'done' | 'merged' | 'failed';

export interface SyncRun {
  id?: number;
  /** ISO 8601. */
  finishedAt: string;
  outcome: SyncOutcome;
  sent: number;
  received: number;
  detail: string;
}

export type ChangeVerb = 'added' | 'edited' | 'deleted';

/** A local change the server has not received yet. */
export interface PendingChange {
  patientId: string;
  verb: ChangeVerb;
  summary: string;
  /** Epoch milliseconds. */
  time: number;
}

export const PATIENT_STATUS_LABELS: Record<PatientStatus, string> = {
  active: 'Active',
  inactive: 'Inactive',
  suspended: 'Suspended',
};

/** "Active", or the raw value when another device wrote one outside PatientStatus. */
export function statusLabel(status: string): string {
  return PATIENT_STATUS_LABELS[status as PatientStatus] ?? status;
}

export function visitTypeLabel(type: string): string {
  return VISIT_TYPE_LABELS[type as VisitType] ?? type;
}

/** What the visit was for: the reason if given, else the visit type. */
export function visitTitle(v: Pick<Visit, 'reason' | 'visitType'>): string {
  return v.reason || visitTypeLabel(v.visitType);
}

/** Human label for a document key, used in conflict banners. */
export function fieldLabel(key: string): string {
  const labels: Record<string, string> = {
    name: 'name',
    phone: 'phone number',
    status: 'status',
    location: 'location',
    head_of_household: 'head of household',
    registered_at: 'registration time',
    visit_type: 'visit type',
    timestamp: 'visit time',
    reason: 'visit reason',
    deleted_at: 'deleted visit',
  };
  return labels[key] ?? VITAL_FIELDS.find((f) => f.docKey === key)?.label.toLowerCase() ?? key;
}

/** A stored value as a person would read it, e.g. "38.4 °C". */
export function displayValue(key: string, value: string): string {
  if (!value) return 'blank';
  const vital = VITAL_FIELDS.find((f) => f.docKey === key);
  if (vital) return `${value} ${vital.unit}`;
  if (key === 'visit_type') return visitTypeLabel(value);
  if (key === 'status') return statusLabel(value);
  return value;
}
