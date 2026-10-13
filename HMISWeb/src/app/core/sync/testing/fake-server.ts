import type { Doc, ImmutableString } from '@automerge/automerge/slim';
import type { Automerge } from '../../db/automerge';
import type { PatientDoc, VisitMap } from '../../db/patient-doc';
import { fromBase64, toBase64 } from '../../util/base64';
import type { Manifest, SyncReply } from '../sync-api';

/**
 * In-memory stand-in for HMIS/patients/sync_views.py. Like the Django server it starts a fresh
 * SyncState on every request and reports invalid values as problems instead of rejecting them.
 */
export class FakeServer {
  readonly docs = new Map<string, Uint8Array>();
  /** Runs before each POST /api/sync/ is answered, to simulate work happening mid-sync. */
  beforeExchange?: () => Promise<void>;

  constructor(private readonly A: Automerge) {}

  async reachable(): Promise<boolean> {
    return true;
  }

  async manifest(): Promise<Manifest> {
    const docs: Manifest['docs'] = {};
    for (const [id, bytes] of this.docs) docs[id] = [...this.A.getHeads(this.A.load(bytes))].sort();
    return { server_time: new Date().toISOString(), docs };
  }

  async exchange(messages: Record<string, string>): Promise<SyncReply> {
    await this.beforeExchange?.();
    const A = this.A;
    const reply: SyncReply = { docs: {}, problems: {} };
    for (const [id, b64] of Object.entries(messages)) {
      const stored = this.docs.get(id);
      let doc = stored ? A.load<PatientDoc>(stored) : A.init<PatientDoc>();
      const before = A.getHeads(doc).join();
      let state;
      [doc, state] = A.receiveSyncMessage(doc, A.initSyncState(), fromBase64(b64));
      const [, out] = A.generateSyncMessage(doc, state);
      reply.docs[id] = out ? toBase64(out) : null;
      if (A.getHeads(doc).join() !== before) {
        this.docs.set(id, A.save(doc));
        const status = doc.patient?.status?.val;
        if (status && !['active', 'inactive', 'suspended'].includes(status)) {
          reply.problems[id] = [`patient.status: Value '${status}' is not a valid choice.`];
        }
      }
    }
    return reply;
  }

  /** A REST edit on the server, mirrored into the document as crdt.write_patient does. */
  edit(id: string, fn: (doc: PatientDoc, A: Automerge) => void): void {
    const doc = this.A.change(this.A.load<PatientDoc>(this.docs.get(id)!), (d) => fn(d, this.A));
    this.docs.set(id, this.A.save(doc));
  }

  /**
   * What patients/duplicates.py merge() does: copy the duplicate's visits (same ids) into the
   * canonical document, then write merged_into into the duplicate's.
   */
  merge(duplicate: string, canonical: string): void {
    const visits = this.read(duplicate).visits ?? {};
    this.edit(canonical, (d, A) => {
      for (const [id, v] of Object.entries(visits)) {
        if (d.visits[id]) continue;
        const copy: Record<string, ImmutableString> = {};
        for (const [key, value] of Object.entries(v)) {
          copy[key] = new A.ImmutableString((value as ImmutableString).val);
        }
        d.visits[id] = copy as unknown as VisitMap;
      }
    });
    this.edit(duplicate, (d, A) => (d.patient.merged_into = new A.ImmutableString(canonical)));
  }

  read(id: string): Doc<PatientDoc> {
    return this.A.load<PatientDoc>(this.docs.get(id)!);
  }
}
