import { Injectable, inject } from '@angular/core';
import type { Doc } from '@automerge/automerge/slim';
import { Subject } from 'rxjs';
import { newId } from '../util/id';
import { loadAutomerge, type Automerge } from './automerge';
import { HMIS_DB } from './hmis-db';
import type { PendingChange } from './models';
import {
  headsKey,
  parseMessage,
  project,
  replacedEdits,
  type PatientDoc,
} from './patient-doc';

export type ChangeKind =
  | 'patient.create'
  | 'patient.update'
  | 'visit.create'
  | 'visit.update'
  | 'visit.vitals'
  | 'visit.delete'
  | 'visit.restore'
  | 'conflict.resolve';

/** What a change did, in words. Stored as the Automerge commit message (HMIS/DOCUMENT_SCHEMA.md). */
export interface ChangeMessage {
  kind: ChangeKind;
  /** e.g. "Visit: Grace Njeri". */
  summary: string;
}

/** Identifies this browser in commit messages so other devices can say who made a change. */
export interface DeviceIdentity {
  deviceId: string;
  deviceName: string;
}

export const DEFAULT_DEVICE_NAME = 'Web browser';

/** What merging a synced copy into the stored document brought in. */
export interface MergeResult {
  /** Changes made on other devices that were new to this one. */
  received: number;
  /** Names of the devices that made them ("the server" when unnamed). */
  fromDevices: string[];
}

/**
 * Owns the Automerge documents in IndexedDB. Every write goes through here so the projection
 * tables and the sync flag always move together with the document, in one transaction.
 */
@Injectable({ providedIn: 'root' })
export class DocStore {
  private readonly db = inject(HMIS_DB);

  /** Emits after each local edit is committed. */
  readonly localChange = new Subject<string>();

  private identityLoad?: Promise<DeviceIdentity>;

  /** This browser's device id (created on first use) and name. */
  identity(): Promise<DeviceIdentity> {
    this.identityLoad ??= this.db
      .transaction('rw', this.db.meta, async () => {
        let deviceId = (await this.db.meta.get('deviceId'))?.value;
        if (!deviceId) {
          deviceId = newId();
          await this.db.meta.put({ key: 'deviceId', value: deviceId });
        }
        const deviceName = (await this.db.meta.get('deviceName'))?.value || DEFAULT_DEVICE_NAME;
        return { deviceId, deviceName };
      })
      .catch((err) => {
        this.identityLoad = undefined;
        throw err;
      });
    return this.identityLoad;
  }

  async setDeviceName(name: string): Promise<void> {
    const value = name.trim() || DEFAULT_DEVICE_NAME;
    await this.db.meta.put({ key: 'deviceName', value });
    this.identityLoad = undefined;
  }

  async create(id: string, message: ChangeMessage, initial: (A: Automerge) => PatientDoc): Promise<void> {
    const A = await loadAutomerge();
    const identity = await this.identity();
    const options = this.commitOptions(identity, message);
    await this.db.transaction('rw', this.writeTables(true), async () => {
      if (await this.db.docs.get(id)) throw new Error('A patient with this id already exists.');
      // Only the registering device creates the patient and visits maps (HMIS/DOCUMENT_SCHEMA.md).
      const doc = A.change(A.init<PatientDoc>(), options, (d) => Object.assign(d, initial(A)));
      await this.write(A, id, doc, identity.deviceId);
      await this.db.dirty.put({ id, token: newId() });
    });
    this.localChange.next(id);
  }

  /**
   * Edits a document. The message may be computed from the document as it was before the edit,
   * for example to name the patient in the summary.
   */
  async change(
    id: string,
    message: ChangeMessage | ((doc: Doc<PatientDoc>) => ChangeMessage),
    fn: (doc: PatientDoc, A: Automerge) => void,
  ): Promise<void> {
    const A = await loadAutomerge();
    const identity = await this.identity();
    await this.db.transaction('rw', this.writeTables(true), async () => {
      const row = await this.db.docs.get(id);
      if (!row) throw new Error('Patient not found.');
      const before = A.load<PatientDoc>(row.bytes);
      const msg = typeof message === 'function' ? message(before) : message;
      const after = A.change(before, this.commitOptions(identity, msg), (d) => fn(d, A));
      if (headsKey(A, after) === row.heads) return;
      await this.write(A, id, after, identity.deviceId);
      await this.db.dirty.put({ id, token: newId() });
    });
    this.localChange.next(id);
  }

  /** Loads documents for a sync session. Unknown ids start empty and are filled by the server. */
  async loadForSync(A: Automerge, ids: Iterable<string>): Promise<Map<string, Doc<PatientDoc>>> {
    const list = [...ids];
    const rows = await this.db.docs.bulkGet(list);
    return new Map(list.map((id, i) => [id, rows[i] ? A.load<PatientDoc>(rows[i]!.bytes) : A.init<PatientDoc>()]));
  }

  /**
   * Stores a document that came back from sync. Merges with whatever is stored now, so local edits
   * made while the sync was running are kept. `headsBefore` are the session copy's heads before
   * the sync, so everything after them came from the server.
   */
  async mergeRemote(
    A: Automerge,
    id: string,
    remote: Doc<PatientDoc>,
    headsBefore: string[] = [],
  ): Promise<MergeResult> {
    const { deviceId } = await this.identity();
    const incoming = A.getChangesMetaSince(remote, headsBefore)
      .map((c) => parseMessage(c.message))
      .filter((m) => m.deviceId !== deviceId);
    await this.db.transaction('rw', this.writeTables(false), async () => {
      const row = await this.db.docs.get(id);
      const merged = row ? A.merge(A.load<PatientDoc>(row.bytes), remote) : remote;
      if (A.getHeads(merged).length === 0) return;
      if (row && headsKey(A, merged) === row.heads) return;
      await this.write(A, id, merged, deviceId);
    });
    return {
      received: incoming.length,
      fromDevices: [...new Set(incoming.map((m) => m.deviceName ?? 'the server'))],
    };
  }

  /** Changes made on this device that the server has not received, oldest first. */
  async pendingChanges(): Promise<PendingChange[]> {
    const A = await loadAutomerge();
    const { deviceId } = await this.identity();
    const ids = (await this.db.dirty.toCollection().primaryKeys()) as string[];
    const rows = await this.db.docs.bulkGet(ids);
    const out: PendingChange[] = [];
    for (const row of rows) {
      if (!row) continue;
      const doc = A.load<PatientDoc>(row.bytes);
      const synced = row.syncedHeads ? row.syncedHeads.split(',') : [];
      for (const c of A.getChangesMetaSince(doc, synced)) {
        const m = parseMessage(c.message);
        if (m.deviceId !== deviceId) continue;
        out.push({
          patientId: row.id,
          verb: m.kind === 'patient.create' || m.kind === 'visit.create'
            ? 'added'
            : m.kind === 'visit.delete' ? 'deleted' : 'edited',
          summary: m.summary ?? 'Change',
          time: c.time * 1000,
        });
      }
    }
    return out.sort((a, b) => a.time - b.time);
  }

  /** Records that the server has everything up to `heads` for this document. */
  async markSynced(id: string, heads: string): Promise<void> {
    await this.db.docs.update(id, { syncedHeads: heads });
  }

  private writeTables(withDirty: boolean) {
    const tables = [this.db.docs, this.db.patients, this.db.visits, this.db.replaced];
    return withDirty ? [...tables, this.db.dirty] : tables;
  }

  private commitOptions(identity: DeviceIdentity, message: ChangeMessage) {
    return {
      message: JSON.stringify({
        device_id: identity.deviceId,
        device_name: identity.deviceName,
        kind: message.kind,
        summary: message.summary,
      }),
      time: Math.floor(Date.now() / 1000),
    };
  }

  private async write(A: Automerge, id: string, doc: Doc<PatientDoc>, deviceId: string): Promise<void> {
    const stored = await this.db.docs.get(id);
    await this.db.docs.put({
      id,
      bytes: A.save(doc),
      heads: headsKey(A, doc),
      syncedHeads: stored?.syncedHeads,
    });
    await this.db.visits.where('patientId').equals(id).delete();
    await this.db.replaced.where('patientId').equals(id).delete();
    const rows = project(A, id, doc);
    if (!rows) return;
    await this.db.patients.put(rows.patient);
    let visits = rows.visits;
    if (rows.patient.mergedInto) {
      // The server copied these visits, same ids, into the canonical document: its rows win.
      const existing = await this.db.visits.bulkGet(visits.map((v) => v.id));
      visits = visits.filter((_, i) => !existing[i]);
    }
    await this.db.visits.bulkPut(visits);
    await this.db.replaced.bulkPut(replacedEdits(A, id, doc, deviceId));
  }
}
