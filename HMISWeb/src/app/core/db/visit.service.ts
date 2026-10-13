import { Injectable, inject } from '@angular/core';
import type { Doc, ImmutableString } from '@automerge/automerge/slim';
import Dexie from 'dexie';
import { Observable } from 'rxjs';
import { newId } from '../util/id';
import { DocStore, type ChangeKind, type ChangeMessage } from './doc-store';
import { HMIS_DB } from './hmis-db';
import { fromLiveQuery } from './live-query';
import { VITAL_FIELDS, type Visit, type VisitInput } from './models';
import type { PatientDoc, VisitMap } from './patient-doc';
import { PatientService } from './patient.service';

/**
 * Visits live inside their patient's document, so they cannot move between patients. Deleting a
 * visit sets deleted_at instead of removing it (HMIS/DOCUMENT_SCHEMA.md); lists hide those visits.
 */
@Injectable({ providedIn: 'root' })
export class VisitService {
  private readonly db = inject(HMIS_DB);
  private readonly store = inject(DocStore);
  private readonly patients = inject(PatientService);

  /** All visits that are not deleted, newest first. */
  readonly visits$: Observable<Visit[]> = fromLiveQuery(() =>
    this.db.visits
      .orderBy('timestamp')
      .reverse()
      .filter((v) => !v.deletedAt)
      .toArray(),
  );

  forPatient$(patientId: string): Observable<Visit[]> {
    return fromLiveQuery(() =>
      this.db.visits
        .where('[patientId+timestamp]')
        .between([patientId, Dexie.minKey], [patientId, Dexie.maxKey])
        .reverse()
        .filter((v) => !v.deletedAt)
        .toArray(),
    );
  }

  /** Including deleted visits, newest first, for the patient page's "Show deleted visits". */
  forPatientAll$(patientId: string): Observable<Visit[]> {
    return fromLiveQuery(() =>
      this.db.visits
        .where('[patientId+timestamp]')
        .between([patientId, Dexie.minKey], [patientId, Dexie.maxKey])
        .reverse()
        .toArray(),
    );
  }

  /** Returns the visit even when it is deleted, so it can be shown or restored. */
  get(id: string): Promise<Visit | undefined> {
    return this.db.visits.get(id);
  }

  /** A visit for a merged patient goes into the patient it was merged into. */
  async create(patientId: string, input: VisitInput): Promise<string> {
    const id = newId();
    const values = docValues(input);
    const target = await this.patients.canonicalId(patientId);
    await this.store.change(target, message('visit.create', 'Visit'), (d, A) => {
      // Never create the visits map here: a second copy made on this device would lose to the
      // server's on merge, and visits written into it would disappear.
      if (!d.visits) throw new Error('This patient has not finished downloading. Sync and try again.');
      const visit: Record<string, ImmutableString> = {};
      for (const [key, value] of Object.entries(values)) visit[key] = new A.ImmutableString(value);
      visit['deleted_at'] = new A.ImmutableString('');
      d.visits[id] = visit as unknown as VisitMap;
    });
    return id;
  }

  async update(id: string, input: VisitInput): Promise<void> {
    const visit = await this.db.visits.get(id);
    if (!visit) throw new Error('Visit not found.');
    const values = docValues(input);
    const before = docValues(visit);
    const changed = Object.keys(values).filter((k) => values[k] !== before[k]);
    const vitalKeys = new Set(VITAL_FIELDS.map((f) => f.docKey));
    const onlyVitals = changed.length > 0 && changed.every((k) => vitalKeys.has(k));
    const kind = onlyVitals ? 'visit.vitals' : 'visit.update';
    await this.store.change(visit.patientId, message(kind, onlyVitals ? 'Vitals' : 'Visit'), (d, A) => {
      const v = d.visits?.[id] as unknown as Record<string, ImmutableString | undefined> | undefined;
      if (!v) throw new Error('Visit not found.');
      // Only touch keys that changed, so concurrent edits to other keys on other devices survive.
      for (const [key, value] of Object.entries(values)) {
        if ((v[key]?.val ?? '') !== value) v[key] = new A.ImmutableString(value);
      }
    });
  }

  /** Marks the visit deleted. It stays in the document and on the server. */
  delete(id: string): Promise<void> {
    return this.setDeletedAt(id, new Date().toISOString(), 'visit.delete');
  }

  restore(id: string): Promise<void> {
    return this.setDeletedAt(id, '', 'visit.restore');
  }

  private async setDeletedAt(id: string, value: string, kind: ChangeKind): Promise<void> {
    const visit = await this.db.visits.get(id);
    if (!visit) throw new Error('Visit not found.');
    await this.store.change(visit.patientId, message(kind, 'Visit'), (d, A) => {
      const v = d.visits?.[id];
      if (!v) throw new Error('Visit not found.');
      if ((v.deleted_at?.val ?? '') !== value) v.deleted_at = new A.ImmutableString(value);
    });
  }
}

/** Builds the commit message from the document, naming the patient. */
function message(kind: ChangeKind, label: string): (doc: Doc<PatientDoc>) => ChangeMessage {
  return (doc) => ({ kind, summary: `${label}: ${doc.patient?.name?.val ?? 'patient'}` });
}

/** Visit fields keyed by their document key, trimmed. */
function docValues(input: VisitInput | Visit): Record<string, string> {
  const values: Record<string, string> = {
    visit_type: input.visitType,
    timestamp: input.timestamp,
    reason: (input.reason ?? '').trim(),
  };
  for (const f of VITAL_FIELDS) values[f.docKey] = (input[f.key] ?? '').trim();
  return values;
}
