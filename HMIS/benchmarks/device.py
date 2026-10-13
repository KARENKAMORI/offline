"""Simulated Flutter offline device.

There is no usable Dart Automerge package, so a Flutter app would wrap the
Rust `automerge` crate with flutter_rust_bridge. The Python binding here wraps
the same Rust core, so it stands in for that device. Same CLI as
client/device.mjs:

    python device.py <phase> <server> <stateDir> [seed]
"""
import base64
import hashlib
import json
import os
import random
import sys
import time
import urllib.request
import uuid
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

from automerge.core import ROOT, Document, Message, ObjType, ScalarType, SyncState, extract

BATCH = 500
# A sync normally settles in 2-4 rounds; a client must never loop forever.
MAX_ROUNDS = 20
STATUSES = ['active', 'inactive', 'suspended']
VISIT_TYPES = ['outpatient', 'inpatient', 'follow_up', 'home_visit']
CFG = {k: int(os.environ.get(k.upper(), d)) for k, d in
       [('new_patients', 20), ('visits', 50), ('status_edits', 20), ('hot', 5)]}


def http(url, body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, headers={'content-type': 'application/json'})
    with urllib.request.urlopen(request, timeout=120) as response:
        raw = response.read()
    return json.loads(raw), len(data or b''), len(raw)


class Device:
    def __init__(self, server, state_dir, seed):
        self.server, self.seed = server, seed
        self.docs_dir = Path(state_dir) / 'docs'
        self.docs_dir.mkdir(parents=True, exist_ok=True)
        self.meta_path = Path(state_dir) / 'meta.json'
        self.meta = json.loads(self.meta_path.read_text()) if self.meta_path.exists() else {'since': None, 'dirty': []}
        start = time.perf_counter()
        self.docs = {p.stem: Document.load(p.read_bytes()) for p in self.docs_dir.glob('*.am')}
        self.load_ms = (time.perf_counter() - start) * 1000

    def save(self, ids):
        for doc_id in ids:
            (self.docs_dir / f'{doc_id}.am').write_bytes(self.docs[doc_id].save())
        self.meta_path.write_text(json.dumps(self.meta))

    def sync(self, full):
        start = time.perf_counter()
        query = f'?since={quote(self.meta["since"])}' if self.meta['since'] and not full else ''
        manifest, _, manifest_bytes = http(f'{self.server}/api/sync/manifest/{query}')
        ids = set(self.meta['dirty'])
        for doc_id, heads in manifest['docs'].items():
            doc = self.docs.setdefault(doc_id, Document())
            if sorted(h.hex() for h in doc.get_heads()) != heads:
                ids.add(doc_id)

        m = {'roundTrips': 1, 'bytesUp': 0, 'bytesDown': manifest_bytes, 'docs': len(ids), 'problems': 0, 'resets': 0}
        states = {doc_id: SyncState() for doc_id in ids}
        last_sent = {}
        trace = {}
        pending = list(ids)
        for round_number in range(1, MAX_ROUNDS + 2):
            if not pending:
                break
            if round_number > MAX_ROUNDS:
                stuck = [(d, [h.hex() for h in self.docs[d].get_heads()]) for d in pending[:3]]
                if os.environ.get('SYNC_TRACE'):
                    (self.docs_dir.parent / 'stuck.json').write_text(json.dumps({
                        d: {'doc': base64.b64encode(self.docs[d].save()).decode(), 'trace': trace.get(d, [])}
                        for d in pending}))
                raise RuntimeError(f'sync did not settle after {MAX_ROUNDS} rounds: {len(pending)} docs, e.g. {stuck}')
            outgoing = {}
            for doc_id in pending:
                message = self.docs[doc_id].generate_sync_message(states[doc_id])
                encoded = base64.b64encode(message.encode()).decode() if message is not None else None
                # Same stall recovery as client/device.mjs: a repeated message
                # means the server dropped changes we marked as sent.
                if encoded is not None and last_sent.get(doc_id) == encoded:
                    states[doc_id] = SyncState()
                    message = self.docs[doc_id].generate_sync_message(states[doc_id])
                    encoded = base64.b64encode(message.encode()).decode() if message is not None else None
                    m['resets'] += 1
                if encoded is not None:
                    outgoing[doc_id] = last_sent[doc_id] = encoded
            keys = list(outgoing)
            if not keys:
                break
            for i in range(0, len(keys), BATCH):
                reply, up, down = http(f'{self.server}/api/sync/', {'docs': {k: outgoing[k] for k in keys[i:i + BATCH]}})
                m['roundTrips'] += 1
                m['bytesUp'] += up
                m['bytesDown'] += down
                m['problems'] += len(reply['problems'])
                for doc_id, encoded in reply['docs'].items():
                    if os.environ.get('SYNC_TRACE'):
                        trace.setdefault(doc_id, []).append([outgoing[doc_id], encoded])
                    if encoded:
                        self.docs[doc_id].receive_sync_message(states[doc_id], Message.decode(base64.b64decode(encoded)))
            pending = keys
        m['ms'] = (time.perf_counter() - start) * 1000
        self.meta.update(since=manifest['server_time'], dirty=[])
        self.save(ids)
        return m

    def edit(self):
        rand = random.Random(self.seed)
        ids = sorted(self.docs)
        hot = ids[:CFG['hot']]
        dirty = set(self.meta['dirty'])
        now = lambda: datetime.now(timezone.utc).isoformat()

        def child(tx, obj, key):
            return tx.get(obj, key)[1]

        def add_visit(tx):
            visit = tx.put_object(child(tx, ROOT, 'visits'), str(uuid.uuid4()), ObjType.Map)
            tx.put(visit, 'visit_type', ScalarType.Str, rand.choice(VISIT_TYPES))
            tx.put(visit, 'timestamp', ScalarType.Str, now())

        def set_status(tx):
            tx.put(child(tx, ROOT, 'patient'), 'status', ScalarType.Str, rand.choice(STATUSES))

        for i in range(CFG['new_patients']):
            doc_id, doc = str(uuid.uuid4()), Document()
            with doc.transaction() as tx:
                patient = tx.put_object(ROOT, 'patient', ObjType.Map)
                tx.put_object(ROOT, 'visits', ObjType.Map)
                for key, value in [('name', f'Flutter patient {self.seed}-{i}'), ('phone', ''), ('status', 'active'),
                                   ('location', 'Kisumu'), ('registered_at', now())]:
                    tx.put(patient, key, ScalarType.Str, value)
                tx.put(patient, 'head_of_household', ScalarType.Boolean, rand.random() < 0.3)
            self.docs[doc_id] = doc
            dirty.add(doc_id)
        for _ in range(CFG['visits']):
            doc_id = rand.choice(ids)
            with self.docs[doc_id].transaction() as tx:
                add_visit(tx)
            dirty.add(doc_id)
        for _ in range(CFG['status_edits']):
            doc_id = rand.choice(ids)
            with self.docs[doc_id].transaction() as tx:
                set_status(tx)
            dirty.add(doc_id)
        for doc_id in hot:
            with self.docs[doc_id].transaction() as tx:
                set_status(tx)
                tx.put(child(tx, ROOT, 'patient'), 'phone', ScalarType.Str, f'07{str(self.seed).zfill(8)}')
                add_visit(tx)
            dirty.add(doc_id)
        self.meta['dirty'] = sorted(dirty)
        self.save(dirty)
        return {'edited': len(dirty)}

    def digest(self):
        return {doc_id: digest(doc) for doc_id, doc in self.docs.items()}


def digest(doc):
    canonical = json.dumps(extract(doc), sort_keys=True, separators=(',', ':'), ensure_ascii=False)
    return hashlib.sha256(canonical.encode()).hexdigest()


def main():
    phase, server, state_dir, *rest = sys.argv[1:]
    device = Device(server, state_dir, int(rest[0]) if rest else 1)
    if phase == 'pull':
        result = device.sync(full=True)
    elif phase == 'sync':
        result = device.sync(full=False)
    elif phase == 'edit':
        result = device.edit()
    elif phase == 'digest':
        result = {'digest': device.digest()}
    else:
        raise SystemExit(f'unknown phase {phase}')
    print(json.dumps({'client': 'py', 'phase': phase, 'loadMs': device.load_ms, 'docCount': len(device.docs), **result}))


if __name__ == '__main__':
    main()
