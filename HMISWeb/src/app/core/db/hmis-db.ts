import { InjectionToken } from '@angular/core';
import Dexie, { type Table } from 'dexie';
import type { MergeNotice, Patient, ReplacedEdit, SyncRun, Visit } from './models';

/** A patient's Automerge document, saved as bytes. The source of truth for that patient. */
export interface DocRow {
  id: string;
  bytes: Uint8Array;
  /** Sorted change hashes joined with ",", compared against the server manifest. */
  heads: string;
  /** Heads the server is known to have; this device's changes after these are pending. */
  syncedHeads?: string;
}

/** A document with local changes the server has not received yet. */
export interface DirtyRow {
  id: string;
  /** Replaced on every edit, so a sync only clears the flag if nothing changed while it ran. */
  token: string;
}

/** Values the server could not apply to its relational copy of a document. */
export interface ProblemRow {
  id: string;
  messages: string[];
}

export interface MetaRow {
  key: 'since' | 'lastSyncedAt' | 'deviceId' | 'deviceName' | 'workerName' | 'area' | 'serverUrl';
  value: string;
}

export class HmisDb extends Dexie {
  docs!: Table<DocRow, string>;
  patients!: Table<Patient, string>;
  visits!: Table<Visit, string>;
  dirty!: Table<DirtyRow, string>;
  problems!: Table<ProblemRow, string>;
  meta!: Table<MetaRow, string>;
  replaced!: Table<ReplacedEdit, [string, string, string]>;
  notices!: Table<MergeNotice, number>;
  syncRuns!: Table<SyncRun, number>;

  constructor(name = 'hmis') {
    super(name);
    // Bump the version and add an upgrade() when the schema changes. Never edit a shipped version.
    this.version(1).stores({
      patients: 'id, name, phone, status, location, headOfHouseholdId, updatedAt',
      visits: 'id, patientId, visitType, timestamp, [patientId+timestamp]',
    });
    // v2: Automerge documents become the source of truth and patients/visits a projection of them.
    // v1 rows have no document behind them and cannot sync, so they are dropped.
    this.version(2)
      .stores({
        docs: 'id',
        patients: 'id, name, status, location',
        visits: 'id, patientId, visitType, timestamp, [patientId+timestamp]',
        dirty: 'id',
        problems: 'id',
        meta: 'key',
      })
      .upgrade((tx) => Promise.all([tx.table('patients').clear(), tx.table('visits').clear()]));
    // v3: what sync tells the user. replaced is rebuilt from each document, notices and syncRuns
    // are history.
    this.version(3).stores({
      replaced: '[patientId+path+key], patientId',
      notices: '++id, dismissed',
      syncRuns: '++id',
    });
    // v4: patients carry mergedInto. Rows projected before this read it as ''. A document may
    // already hold the server's merged_into, so forget the stored heads and the manifest cursor:
    // the next sync then compares every document and writes its projection again.
    this.version(4)
      .stores({})
      .upgrade((tx) =>
        Promise.all([
          tx.table('patients').toCollection().modify((p: Patient) => void (p.mergedInto ??= '')),
          tx.table('docs').toCollection().modify((d: DocRow) => void (d.heads = '')),
          tx.table('meta').delete('since'),
        ]),
      );
  }
}

export const HMIS_DB = new InjectionToken<HmisDb>('HMIS_DB', {
  providedIn: 'root',
  factory: () => new HmisDb(),
});
