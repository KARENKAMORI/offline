import { HttpErrorResponse } from '@angular/common/http';
import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import type { Doc } from '@automerge/automerge/slim';
import { Observable, TimeoutError } from 'rxjs';
import { loadAutomerge, type Automerge } from '../db/automerge';
import { DocStore } from '../db/doc-store';
import { HMIS_DB } from '../db/hmis-db';
import { fromLiveQuery } from '../db/live-query';
import type { MergeResult } from '../db/doc-store';
import type { MergeNotice } from '../db/models';
import { headsKey, type PatientDoc } from '../db/patient-doc';
import { NetworkStatus } from '../network-status';
import { fromBase64, toBase64 } from '../util/base64';
import { SYNC_CONFIG, SyncApi, isUnreachable } from './sync-api';

/** The server's per-request limit (MAX_DOCS_PER_REQUEST). */
const BATCH = 500;
/** A sync normally settles in 2 to 4 rounds; never loop forever. */
const MAX_ROUNDS = 20;

export type SyncPhase = 'idle' | 'syncing' | 'error';

/** What the status pill shows: whether the device has internet, or that a sync is running. */
export type Connection = 'online' | 'offline' | 'syncing';

/**
 * Syncs patient documents with the HMIS server using the Automerge sync protocol, following
 * HMIS/benchmarks/client/device.mjs. The app never waits on this: every screen reads and writes
 * IndexedDB, and sync runs in the background whenever the server is reachable.
 */
@Injectable({ providedIn: 'root' })
export class SyncService {
  private readonly db = inject(HMIS_DB);
  private readonly api = inject(SyncApi);
  private readonly store = inject(DocStore);
  private readonly network = inject(NetworkStatus);
  private readonly config = inject(SYNC_CONFIG);
  private readonly destroyRef = inject(DestroyRef);

  readonly phase = signal<SyncPhase>('idle');
  readonly lastError = signal<string | null>(null);
  readonly lastSyncedAt = signal<string | null>(null);
  readonly pendingCount = toSignal(fromLiveQuery(() => this.db.dirty.count()), { initialValue: 0 });

  readonly connection = computed<Connection>(() => {
    if (!this.network.online()) return 'offline';
    return this.phase() === 'syncing' ? 'syncing' : 'online';
  });
  /** While syncing: documents settled so far, out of progressTotal. */
  readonly progressDone = signal(0);
  readonly progressTotal = signal(0);
  /** While syncing: local changes being sent. */
  readonly sending = signal(0);

  private running: Promise<void> | null = null;
  private rerun = false;
  private debounce?: ReturnType<typeof setTimeout>;
  private retry?: ReturnType<typeof setTimeout>;
  /** Failed syncs in a row, which sets how long to wait before the next retry. */
  private failures = 0;
  private started = false;

  /** Ids of patients with local changes the server has not received. */
  readonly pendingIds$: Observable<Set<string>> = fromLiveQuery(async () =>
    new Set(await this.db.dirty.toCollection().primaryKeys()),
  );

  problemsFor$(patientId: string): Observable<string[]> {
    return fromLiveQuery(async () => (await this.db.problems.get(patientId))?.messages ?? []);
  }

  /** Wires the background triggers. Call once at app start. */
  start(): void {
    if (this.started) return;
    this.started = true;
    this.network.start();
    void this.db.meta.get('lastSyncedAt').then((row) => row && this.lastSyncedAt.set(row.value));

    const reconnected = this.network.reconnected.subscribe(() => {
      // A running sync that reached the server needs no second one.
      if (this.running) return;
      this.failures = 0;
      void this.syncNow();
    });
    const onVisible = () => document.visibilityState === 'visible' && void this.syncNow();
    document.addEventListener('visibilitychange', onVisible);
    const interval = setInterval(() => void this.syncNow(), this.config.intervalMs);
    const sub = this.store.localChange.subscribe(() => this.schedule());
    this.destroyRef.onDestroy(() => {
      reconnected.unsubscribe();
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(interval);
      clearTimeout(this.debounce);
      clearTimeout(this.retry);
      this.started = false;
      sub.unsubscribe();
    });
    void this.syncNow();
  }

  /** Syncs shortly after a local edit. */
  schedule(): void {
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => void this.syncNow(), this.config.debounceMs);
  }

  /** Runs a sync now, or once more after the current one if one is in flight. */
  syncNow(): Promise<void> {
    if (!this.network.online()) return Promise.resolve();
    if (this.running) {
      this.rerun = true;
      return this.running;
    }
    clearTimeout(this.retry);
    this.running = this.exclusive(() => this.run()).finally(() => {
      this.running = null;
      if (this.rerun) {
        this.rerun = false;
        void this.syncNow();
      }
    });
    return this.running;
  }

  /** Only one tab syncs a given database at a time. */
  private async exclusive(task: () => Promise<void>): Promise<void> {
    if (!navigator.locks) return task();
    await navigator.locks.request(`hmis-sync:${this.db.name}`, { ifAvailable: true }, async (lock) => {
      if (lock) await task();
    });
  }

  private async run(): Promise<void> {
    this.phase.set('syncing');
    try {
      const A = await loadAutomerge();
      // Snapshot the flags before reading any doc: an edit after this point gets a new token and
      // stays flagged, so it goes out on the next sync even if this one already carried it.
      const dirty = await this.db.dirty.toArray();
      const pending = await this.store.pendingChanges();
      const since = (await this.db.meta.get('since'))?.value ?? null;
      const manifest = await this.api.manifest(since);
      this.network.confirmed();

      const ids = new Set(dirty.map((d) => d.id));
      const remoteIds = Object.keys(manifest.docs);
      const stored = await this.db.docs.bulkGet(remoteIds);
      remoteIds.forEach((id, i) => {
        if (stored[i]?.heads !== [...manifest.docs[id]].sort().join(',')) ids.add(id);
      });

      this.sending.set(pending.length);
      this.progressTotal.set(ids.size);
      this.progressDone.set(0);

      const docs = await this.store.loadForSync(A, ids);
      const headsBefore = new Map([...docs].map(([id, doc]) => [id, [...A.getHeads(doc)]]));
      const problems = await this.exchange(A, docs);

      let received = 0;
      const merged = new Map<string, MergeResult>();
      const dirtyIds = new Set(dirty.map((d) => d.id));
      for (const [id, doc] of docs) {
        const result = await this.store.mergeRemote(A, id, doc, headsBefore.get(id));
        received += result.received;
        // Both sides changed this patient: tell the user the edits merged.
        if (dirtyIds.has(id) && result.received > 0) merged.set(id, result);
      }
      const notices = await this.mergeNotices(merged);

      const now = new Date().toISOString();
      const tables = [this.db.dirty, this.db.problems, this.db.meta, this.db.docs, this.db.notices, this.db.syncRuns];
      await this.db.transaction('rw', tables, async () => {
        for (const d of dirty) {
          if ((await this.db.dirty.get(d.id))?.token === d.token) await this.db.dirty.delete(d.id);
        }
        for (const [id, doc] of docs) {
          if (A.getHeads(doc).length) await this.store.markSynced(id, headsKey(A, doc));
          await this.db.problems.delete(id);
        }
        for (const [id, messages] of Object.entries(problems)) {
          await this.db.problems.put({ id, messages });
        }
        await this.db.notices.bulkAdd(notices.map((n) => n.notice));
        if (pending.length || received || notices.length) {
          await this.db.syncRuns.add({
            finishedAt: now,
            outcome: notices.length ? 'merged' : 'done',
            sent: pending.length,
            received,
            detail: notices.length
              ? notices.map((n) => n.summary).join('; ')
              : counts(pending.length, received),
          });
        }
        await this.db.meta.bulkPut([
          { key: 'since', value: manifest.server_time },
          { key: 'lastSyncedAt', value: now },
        ]);
      });
      this.lastSyncedAt.set(now);
      this.lastError.set(null);
      this.phase.set('idle');
      this.failures = 0;
    } catch (err) {
      const detail = describe(err);
      await this.recordFailure(detail).catch(() => undefined);
      this.lastError.set(detail);
      this.phase.set('error');
      if (lostConnection(err)) this.network.lost();
      this.retrySoon();
    } finally {
      this.sending.set(0);
      this.progressTotal.set(0);
      this.progressDone.set(0);
    }
  }

  /** Retries a failed sync with backoff, instead of waiting out the full interval. */
  private retrySoon(): void {
    if (!this.started) return;
    const { retryMs, intervalMs } = this.config;
    const delay = Math.min(retryMs[Math.min(this.failures, retryMs.length - 1)] ?? intervalMs, intervalMs);
    this.failures++;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => void this.syncNow(), delay);
  }

  private async mergeNotices(
    merged: Map<string, MergeResult>,
  ): Promise<{ notice: MergeNotice; summary: string }[]> {
    const out: { notice: MergeNotice; summary: string }[] = [];
    const now = new Date().toISOString();
    for (const [id, result] of merged) {
      // A replaced edit gets its own banner instead.
      if (await this.db.replaced.where('patientId').equals(id).count()) continue;
      const name = (await this.db.patients.get(id))?.name ?? 'A patient';
      const from = result.fromDevices.length === 1 ? result.fromDevices[0] : 'other devices';
      out.push({
        notice: {
          patientId: id,
          title: `Merged a change from ${from}`,
          body: `${name}'s record now has both edits.`,
          createdAt: now,
          dismissed: 0,
        },
        summary: `${name}: edits merged`,
      });
    }
    return out;
  }

  /** Background syncs retry every minute while the server is down; keep one line per outage. */
  private async recordFailure(detail: string): Promise<void> {
    const finishedAt = new Date().toISOString();
    await this.db.transaction('rw', this.db.syncRuns, async () => {
      const last = await this.db.syncRuns.orderBy('id').last();
      if (last?.outcome === 'failed') {
        await this.db.syncRuns.update(last.id!, { finishedAt, detail });
      } else {
        await this.db.syncRuns.add({ finishedAt, outcome: 'failed', sent: 0, received: 0, detail });
      }
    });
  }

  /** Runs sync rounds until no document has anything left to send. Returns server problems. */
  private async exchange(
    A: Automerge,
    docs: Map<string, Doc<PatientDoc>>,
  ): Promise<Record<string, string[]>> {
    const states = new Map([...docs.keys()].map((id) => [id, A.initSyncState()]));
    const lastSent = new Map<string, string>();
    const problems: Record<string, string[]> = {};
    let pending = [...docs.keys()];

    for (let round = 1; pending.length; round++) {
      if (round > MAX_ROUNDS) {
        throw new Error(`Sync did not settle after ${MAX_ROUNDS} rounds (${pending.length} records).`);
      }
      const outgoing: Record<string, string> = {};
      for (const id of pending) {
        const doc = docs.get(id)!;
        let [state, msg] = A.generateSyncMessage(doc, states.get(id)!);
        let encoded = msg && toBase64(msg);
        // The server reloads each doc per request, so changes it had to queue (a dependency was
        // missing) are dropped while this side has marked them as sent. That shows up as the same
        // message repeating: reset the sync state so everything the server lacks is offered again.
        if (encoded && lastSent.get(id) === encoded) {
          [state, msg] = A.generateSyncMessage(doc, A.initSyncState());
          encoded = msg && toBase64(msg);
        }
        states.set(id, state);
        if (encoded) lastSent.set(id, (outgoing[id] = encoded));
      }

      const keys = Object.keys(outgoing);
      this.progressDone.set(this.progressTotal() - keys.length);
      if (!keys.length) break;
      for (let i = 0; i < keys.length; i += BATCH) {
        const batch = Object.fromEntries(keys.slice(i, i + BATCH).map((k) => [k, outgoing[k]]));
        const reply = await this.api.exchange(batch);
        Object.assign(problems, reply.problems);
        for (const [id, b64] of Object.entries(reply.docs)) {
          if (!b64 || !docs.has(id)) continue;
          const [doc, state] = A.receiveSyncMessage(docs.get(id)!, states.get(id)!, fromBase64(b64));
          docs.set(id, doc);
          states.set(id, state);
        }
      }
      pending = keys;
    }
    return problems;
  }
}

function counts(sent: number, received: number): string {
  const n = (count: number, verb: string) => `${count} ${count === 1 ? 'change' : 'changes'} ${verb}`;
  return [sent ? n(sent, 'sent') : '', received ? n(received, 'received') : '']
    .filter(Boolean)
    .join(', ');
}

/** The request got no reply from the server, as opposed to the server refusing it. */
function lostConnection(err: unknown): boolean {
  return err instanceof TimeoutError || (err instanceof HttpErrorResponse && isUnreachable(err.status));
}

function describe(err: unknown): string {
  if (lostConnection(err)) return 'Server unreachable.';
  if (err instanceof HttpErrorResponse) {
    return `The server could not take the changes (error ${err.status}). They are safe on this device.`;
  }
  return err instanceof Error ? err.message : String(err);
}
