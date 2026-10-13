import type { Doc, ImmutableString } from '@automerge/automerge/slim';
import type { Automerge } from './automerge';
import { VITAL_FIELDS, type Patient, type ReplacedEdit, type Visit } from './models';

/**
 * One Automerge document per patient, matching HMIS/patients/crdt.py. Strings are ImmutableString
 * (last writer wins), never plain JS strings, which Automerge would turn into collaborative Text.
 */
export interface PatientDoc {
  patient: {
    name: ImmutableString;
    phone: ImmutableString;
    status: ImmutableString;
    location: ImmutableString;
    head_of_household: boolean;
    registered_at: ImmutableString;
    /** Written only by the server, when it merged this duplicate into another patient. */
    merged_into?: ImmutableString;
  };
  visits: Record<string, VisitMap>;
}

/**
 * One visit in the document. Optional keys may be missing in documents written before they
 * existed; a missing key means the same as ''. See HMIS/DOCUMENT_SCHEMA.md.
 */
export interface VisitMap {
  visit_type: ImmutableString;
  timestamp: ImmutableString;
  reason?: ImmutableString;
  temperature_c?: ImmutableString;
  pulse_bpm?: ImmutableString;
  systolic_mmhg?: ImmutableString;
  diastolic_mmhg?: ImmutableString;
  respiratory_rate?: ImmutableString;
  spo2_pct?: ImmutableString;
  weight_kg?: ImmutableString;
  deleted_at?: ImmutableString;
}

export function headsKey(A: Automerge, doc: Doc<unknown>): string {
  return [...A.getHeads(doc)].sort().join(',');
}

/** Reads a scalar that may be an ImmutableString, a Text string from another client, or missing. */
function text(A: Automerge, value: unknown): string {
  if (value instanceof A.ImmutableString) return value.val;
  return value == null ? '' : String(value);
}

/** Builds the read-model rows for a document. Returns null while the doc has no patient map yet. */
export function project(
  A: Automerge,
  id: string,
  doc: Doc<PatientDoc>,
): { patient: Patient; visits: Visit[] } | null {
  const p = doc.patient;
  if (!p || typeof p !== 'object') return null;
  const visits = doc.visits && typeof doc.visits === 'object' ? doc.visits : {};
  return {
    patient: {
      id,
      name: text(A, p.name),
      phone: text(A, p.phone),
      status: text(A, p.status),
      location: text(A, p.location),
      headOfHousehold: p.head_of_household === true,
      registeredAt: text(A, p.registered_at),
      mergedInto: text(A, p.merged_into),
    },
    visits: Object.entries(visits).map(([visitId, v]) => {
      const raw = (v ?? {}) as unknown as Record<string, unknown>;
      const visit = {
        id: visitId,
        patientId: id,
        visitType: text(A, raw['visit_type']),
        timestamp: text(A, raw['timestamp']),
        reason: text(A, raw['reason']),
        deletedAt: text(A, raw['deleted_at']),
      } as Visit;
      for (const f of VITAL_FIELDS) visit[f.key] = text(A, raw[f.docKey]);
      return visit;
    }),
  };
}

/** What a commit message says about a change (HMIS/DOCUMENT_SCHEMA.md, "Change messages"). */
export interface ChangeAuthor {
  deviceId?: string;
  deviceName?: string;
  kind?: string;
  summary?: string;
}

/** Messages may be missing (REST edits on the server) or not JSON; never throws. */
export function parseMessage(raw: string | null | undefined): ChangeAuthor {
  if (!raw) return {};
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return {};
    const s = (k: string) => (typeof j[k] === 'string' ? (j[k] as string) : undefined);
    return { deviceId: s('device_id'), deviceName: s('device_name'), kind: s('kind'), summary: s('summary') };
  } catch {
    return {};
  }
}

/**
 * Fields where a concurrent edit beat one made on this device. Every replica shows the same winner;
 * only the device whose value lost is told. A browser gets a new Automerge actor per session, so
 * "this device" means changes whose message carries this device's id, not this actor.
 */
export function replacedEdits(
  A: Automerge,
  patientId: string,
  doc: Doc<PatientDoc>,
  myDeviceId: string,
): ReplacedEdit[] {
  const objects: [string, Record<string, unknown>][] = [];
  if (doc.patient && typeof doc.patient === 'object') objects.push(['patient', doc.patient]);
  for (const [id, v] of Object.entries(doc.visits ?? {})) {
    if (v && typeof v === 'object') objects.push([`visits/${id}`, v as unknown as Record<string, unknown>]);
  }
  let authors: Map<string, ChangeAuthor> | undefined;
  const out: ReplacedEdit[] = [];
  for (const [path, obj] of objects) {
    for (const key of Object.keys(obj)) {
      const conflicts = A.getConflicts(obj as Doc<Record<string, unknown>>, key);
      if (!conflicts || Object.keys(conflicts).length < 2) continue;
      authors ??= authorsByActor(A, doc);
      // Automerge keeps the value with the highest op id: counter first, then actor.
      const ops = Object.entries(conflicts)
        .map(([opId, value]) => {
          const [counter, actor] = opId.split('@');
          return { counter: Number(counter), actor, value: text(A, value) };
        })
        .sort((a, b) => b.counter - a.counter || (a.actor < b.actor ? 1 : a.actor > b.actor ? -1 : 0));
      const [winner, ...losers] = ops;
      const mine = losers.find((o) => authors!.get(o.actor)?.deviceId === myDeviceId);
      if (!mine || authors.get(winner.actor)?.deviceId === myDeviceId) continue;
      out.push({
        patientId,
        path,
        key,
        mine: mine.value,
        kept: winner.value,
        keptBy: authors.get(winner.actor)?.deviceName ?? 'the server',
      });
    }
  }
  return out;
}

/** Automerge actor id to the device named in its commit messages. */
export function authorsByActor(A: Automerge, doc: Doc<unknown>): Map<string, ChangeAuthor> {
  const out = new Map<string, ChangeAuthor>();
  for (const c of A.getChangesMetaSince(doc, [])) {
    const author = parseMessage(c.message);
    if (author.deviceId) out.set(c.actor, author);
  }
  return out;
}
