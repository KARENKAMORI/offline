import { Injectable, inject } from '@angular/core';
import { Observable, from, switchMap } from 'rxjs';
import { loadAutomerge } from './automerge';
import { DocStore } from './doc-store';
import { HMIS_DB } from './hmis-db';
import { fromLiveQuery } from './live-query';
import {
  fieldLabel,
  type MergeNotice,
  type PendingChange,
  type ReplacedEdit,
  type SyncOutcome,
  type SyncRun,
} from './models';
import type { PatientDoc } from './patient-doc';

export type NamedReplacedEdit = ReplacedEdit & { patientName: string };

/** What sync has to tell the user: replaced edits, merge notices, history and pending changes. */
@Injectable({ providedIn: 'root' })
export class ActivityService {
  private readonly db = inject(HMIS_DB);
  private readonly store = inject(DocStore);

  readonly replaced$: Observable<NamedReplacedEdit[]> = fromLiveQuery(async () => {
    const edits = await this.db.replaced.toArray();
    const patients = await this.db.patients.bulkGet(edits.map((e) => e.patientId));
    return edits
      .map((e, i) => ({ ...e, patientName: patients[i]?.name ?? 'A patient' }))
      .sort((a, b) => a.patientName.localeCompare(b.patientName));
  });

  readonly notices$: Observable<MergeNotice[]> = fromLiveQuery(() =>
    this.db.notices.where('dismissed').equals(0).reverse().sortBy('id'),
  );

  readonly runs$: Observable<SyncRun[]> = fromLiveQuery(() =>
    this.db.syncRuns.orderBy('id').reverse().limit(50).toArray(),
  );

  readonly runCounts$: Observable<Record<SyncOutcome, number>> = fromLiveQuery(async () => {
    const counts: Record<SyncOutcome, number> = { done: 0, merged: 0, failed: 0 };
    await this.db.syncRuns.each((r) => counts[r.outcome]++);
    return counts;
  });

  readonly problemCount$: Observable<number> = fromLiveQuery(() => this.db.problems.count());

  /**
   * Local changes the server has not received, oldest first. The live query only tracks the
   * tables; reading the documents happens outside it because it needs Automerge.
   */
  readonly pendingChanges$: Observable<PendingChange[]> = fromLiveQuery(async () => [
    await this.db.dirty.count(),
    await this.db.docs.count(),
  ]).pipe(switchMap(() => from(loadAutomerge().then(() => this.store.pendingChanges()))));

  dismissNotice(id: number): Promise<number> {
    return this.db.notices.update(id, { dismissed: 1 });
  }

  /**
   * Re-enter mine, or keep the value that won. Either way the field gets a fresh write, which ends
   * the conflict on every device once it syncs.
   */
  async resolve(edit: NamedReplacedEdit, keepMine: boolean): Promise<void> {
    const value = keepMine ? edit.mine : edit.kept;
    const label = fieldLabel(edit.key);
    const summary = `${label[0].toUpperCase()}${label.slice(1)}: ${edit.patientName}`;
    await this.store.change(edit.patientId, { kind: 'conflict.resolve', summary }, (d, A) => {
      const target = objectAt(d, edit.path);
      if (!target) throw new Error('That record has changed. Sync and try again.');
      target[edit.key] = edit.key === 'head_of_household' ? value === 'true' : new A.ImmutableString(value);
    });
  }
}

function objectAt(doc: PatientDoc, path: string): Record<string, unknown> | undefined {
  if (path === 'patient') return doc.patient as unknown as Record<string, unknown>;
  const visitId = path.startsWith('visits/') ? path.slice('visits/'.length) : '';
  return doc.visits?.[visitId] as unknown as Record<string, unknown> | undefined;
}
