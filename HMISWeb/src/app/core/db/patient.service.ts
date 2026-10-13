import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import { normalizeName, normalizePhone } from '../identity';
import { newId } from '../util/id';
import { DocStore } from './doc-store';
import { HMIS_DB } from './hmis-db';
import { fromLiveQuery } from './live-query';
import type { Patient, PatientInput } from './models';

/**
 * Reads come from the projected patients table. Writes edit the patient's Automerge document.
 * There is no patient delete: the server keeps every record, so set the status to inactive instead.
 */
@Injectable({ providedIn: 'root' })
export class PatientService {
  private readonly db = inject(HMIS_DB);
  private readonly store = inject(DocStore);

  /**
   * Every patient on this device sorted by name, merged duplicates included, so visits still
   * stored under a duplicate can show its name. Re-emits on any change to the patients table.
   */
  readonly allPatients$: Observable<Patient[]> = fromLiveQuery(() =>
    this.db.patients.orderBy('name').toArray(),
  );

  /** Patients to list and pick from: merged duplicates are left out (HMIS/DOCUMENT_SCHEMA.md). */
  readonly patients$: Observable<Patient[]> = this.allPatients$.pipe(
    map((patients) => patients.filter((p) => !p.mergedInto)),
  );

  watch(id: string): Observable<Patient | undefined> {
    return fromLiveQuery(() => this.db.patients.get(id));
  }

  get(id: string): Promise<Patient | undefined> {
    return this.db.patients.get(id);
  }

  /**
   * The patient to show or write to in place of `id`: follows mergedInto as far as this device has
   * the documents. Returns `id` itself when it is not merged or not downloaded.
   */
  async canonicalId(id: string): Promise<string> {
    const seen = new Set([id]);
    let current = id;
    for (;;) {
      const next = (await this.db.patients.get(current))?.mergedInto;
      // Stop at a patient that is not merged, one not downloaded yet, or a cycle.
      if (!next || seen.has(next) || !(await this.db.patients.get(next))) return current;
      seen.add(next);
      current = next;
    }
  }

  /**
   * Unmerged patients on this device with the same normalised phone as `phone`, for the warning
   * shown at registration, split by whether their normalised name matches `name`.
   */
  async samePhone(phone: string, name: string): Promise<{ sameName: Patient[]; otherName: Patient[] }> {
    const number = normalizePhone(phone);
    const sameName: Patient[] = [];
    const otherName: Patient[] = [];
    if (!number) return { sameName, otherName };
    const who = normalizeName(name);
    await this.db.patients.orderBy('name').each((p) => {
      if (p.mergedInto || normalizePhone(p.phone) !== number) return;
      (normalizeName(p.name) === who ? sameName : otherName).push(p);
    });
    return { sameName, otherName };
  }

  async create(input: PatientInput): Promise<string> {
    const id = newId();
    const v = normalize(input);
    const summary = `${v.headOfHousehold ? 'Household' : 'Patient'}: ${v.name}`;
    await this.store.create(id, { kind: 'patient.create', summary }, (A) => ({
      patient: {
        name: new A.ImmutableString(v.name),
        phone: new A.ImmutableString(v.phone),
        status: new A.ImmutableString(v.status),
        location: new A.ImmutableString(v.location),
        head_of_household: v.headOfHousehold,
        registered_at: new A.ImmutableString(new Date().toISOString()),
      },
      visits: {},
    }));
    return id;
  }

  /** Never writes merged_into: only the server does (HMIS/DOCUMENT_SCHEMA.md). */
  async update(id: string, input: PatientInput): Promise<void> {
    const v = normalize(input);
    await this.store.change(id, { kind: 'patient.update', summary: `Patient: ${v.name}` }, (d, A) => {
      const p = d.patient;
      if (!p) throw new Error('This patient has not finished downloading. Sync and try again.');
      // Only touch fields that changed, so concurrent edits to other fields on other devices survive.
      const strings = { name: v.name, phone: v.phone, status: v.status, location: v.location };
      for (const [key, value] of Object.entries(strings) as [keyof typeof strings, string][]) {
        if (p[key]?.val !== value) p[key] = new A.ImmutableString(value);
      }
      if (p.head_of_household !== v.headOfHousehold) p.head_of_household = v.headOfHousehold;
    });
  }
}

function normalize(input: PatientInput): PatientInput {
  return {
    name: input.name.trim(),
    phone: normalizePhone(input.phone),
    status: input.status,
    location: input.location.trim(),
    headOfHousehold: input.headOfHousehold,
  };
}
