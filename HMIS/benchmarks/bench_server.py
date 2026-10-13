"""Server-side Automerge microbenchmarks (Rust core via the Python binding).

    venv/bin/python benchmarks/bench_server.py

A. Document size and cost as a patient's history grows.
B. Granularity: one document per patient vs one document per facility, for a
   device that changed 10 patients offline, and for a cold-start pull.

Every server round here does what crdt.receive() does per request: load the
saved bytes, run one sync round with a fresh SyncState, save.
"""
import json
import random
import statistics
import time
import uuid
from pathlib import Path

from automerge.core import ROOT, Document, ObjType, ScalarType, SyncState, extract

RESULTS = Path(__file__).resolve().parent / 'results'
rand = random.Random(42)


def timed(fn, repeat=5):
    samples = []
    for _ in range(repeat):
        start = time.perf_counter()
        out = fn()
        samples.append((time.perf_counter() - start) * 1000)
    return statistics.median(samples), out


def put_patient(tx, obj, i):
    patient = tx.put_object(obj, 'patient', ObjType.Map)
    for key, value in [('name', f'Patient {i}'), ('phone', '0700000000'), ('status', 'active'),
                       ('location', 'Kibera'), ('registered_at', '2026-10-08T09:00:00+00:00')]:
        tx.put(patient, key, ScalarType.Str, value)
    tx.put(patient, 'head_of_household', ScalarType.Boolean, False)
    return tx.put_object(obj, 'visits', ObjType.Map)


def add_visit(tx, visits):
    visit = tx.put_object(visits, str(uuid.uuid4()), ObjType.Map)
    tx.put(visit, 'visit_type', ScalarType.Str, rand.choice(['outpatient', 'follow_up', 'home_visit']))
    tx.put(visit, 'timestamp', ScalarType.Str, '2026-10-08T09:00:00+00:00')


def patient_doc(visits, status_edits, one_change_per_edit=True):
    doc = Document()
    with doc.transaction() as tx:
        visits_obj = put_patient(tx, ROOT, 0)
    for _ in range(visits):
        with doc.transaction() as tx:
            add_visit(tx, visits_obj)
    for _ in range(status_edits):
        with doc.transaction() as tx:
            tx.put(tx.get(ROOT, 'patient')[1], 'status', ScalarType.Str, rand.choice(['active', 'inactive']))
    return doc


def sync_to_server(client, server_bytes):
    """Sync a client doc against a stateless server. Returns rounds, bytes, server ms, new server bytes."""
    state = SyncState()
    rounds = up = down = 0
    server_ms = 0.0
    while True:
        msg = client.generate_sync_message(state)
        if msg is None:
            return rounds, up, down, server_ms, server_bytes
        rounds += 1
        encoded = msg.encode()
        up += len(encoded)
        start = time.perf_counter()
        server = Document.load(server_bytes) if server_bytes else Document()
        server_state = SyncState()
        server.receive_sync_message(server_state, msg)
        reply = server.generate_sync_message(server_state)
        server_bytes = server.save()
        server_ms += (time.perf_counter() - start) * 1000
        if reply is not None:
            down += len(reply.encode())
            client.receive_sync_message(state, reply)


def bench_history():
    rows = []
    for visits, edits in [(0, 0), (10, 0), (100, 0), (500, 0), (10, 100), (10, 1000), (10, 10000)]:
        doc = patient_doc(visits, edits)
        saved = doc.save()
        json_bytes = len(json.dumps(extract(doc)).encode())
        load_ms, _ = timed(lambda: Document.load(saved))
        save_ms, _ = timed(lambda: Document.load(saved).save(), repeat=3)
        project_ms, _ = timed(lambda: extract(Document.load(saved)))

        def one_new_visit():
            client = Document.load(saved)
            with client.transaction() as tx:
                add_visit(tx, tx.get(ROOT, 'visits')[1])
            return sync_to_server(client, saved)
        _, (rounds, up, down, server_ms, _) = timed(one_new_visit, repeat=3)
        rows.append({'visits': visits, 'statusEdits': edits, 'docBytes': len(saved), 'jsonBytes': json_bytes,
                     'overhead': round(len(saved) / json_bytes, 2), 'loadMs': load_ms, 'loadSaveMs': save_ms,
                     'extractMs': project_ms, 'syncOneVisit': {'rounds': rounds, 'bytesUp': up, 'bytesDown': down,
                                                               'serverMs': server_ms}})
        print(f'history visits={visits:4} edits={edits:5}: {len(saved):7} B doc, {json_bytes:6} B json, '
              f'load {load_ms:7.2f} ms, sync 1 visit {server_ms:7.2f} ms server / {rounds} rounds')
    return rows


def bench_granularity(patients, changed=10):
    # Per-patient: N small docs.
    per_patient = []
    for i in range(patients):
        doc = Document()
        with doc.transaction() as tx:
            visits = put_patient(tx, ROOT, i)
            for _ in range(3):
                add_visit(tx, visits)
        per_patient.append(doc.save())

    # Facility: one doc, patients keyed by UUID.
    facility = Document()
    with facility.transaction() as tx:
        root = tx.put_object(ROOT, 'patients', ObjType.Map)
    keys = []
    for i in range(patients):
        with facility.transaction() as tx:
            key = str(uuid.uuid4())
            keys.append(key)
            visits = put_patient(tx, tx.put_object(root, key, ObjType.Map), i)
            for _ in range(3):
                add_visit(tx, visits)
    facility_bytes = facility.save()

    # Device edits `changed` patients offline, then syncs.
    targets = rand.sample(range(patients), changed)
    start = time.perf_counter()
    rounds = up = down = 0
    server_ms = 0.0
    for t in targets:
        client = Document.load(per_patient[t])
        with client.transaction() as tx:
            add_visit(tx, tx.get(ROOT, 'visits')[1])
        r, u, d, ms, _ = sync_to_server(client, per_patient[t])
        rounds, up, down, server_ms = max(rounds, r), up + u, down + d, server_ms + ms
    per_patient_sync = {'rounds': rounds, 'bytesUp': up, 'bytesDown': down, 'serverMs': server_ms,
                        'totalMs': (time.perf_counter() - start) * 1000}

    client = Document.load(facility_bytes)
    for t in targets:
        with client.transaction() as tx:
            entry = tx.get(tx.get(ROOT, 'patients')[1], keys[t])[1]
            add_visit(tx, tx.get(entry, 'visits')[1])
    start = time.perf_counter()
    r, u, d, ms, _ = sync_to_server(client, facility_bytes)
    facility_sync = {'rounds': r, 'bytesUp': u, 'bytesDown': d, 'serverMs': ms,
                     'totalMs': (time.perf_counter() - start) * 1000}

    # Cold start: an empty device pulls everything.
    start = time.perf_counter()
    cold_up = cold_down = 0
    for saved in per_patient:
        _, u, d, _, _ = sync_to_server(Document(), saved)
        cold_up, cold_down = cold_up + u, cold_down + d
    per_patient_cold = {'bytesUp': cold_up, 'bytesDown': cold_down, 'ms': (time.perf_counter() - start) * 1000,
                        'snapshotBytes': sum(len(b) for b in per_patient)}
    start = time.perf_counter()
    _, u, d, _, _ = sync_to_server(Document(), facility_bytes)
    facility_cold = {'bytesUp': u, 'bytesDown': d, 'ms': (time.perf_counter() - start) * 1000,
                     'snapshotBytes': len(facility_bytes)}

    load_ms, _ = timed(lambda: Document.load(facility_bytes), repeat=3)
    row = {'patients': patients, 'changedPatients': changed,
           'perPatient': {'totalDocBytes': sum(len(b) for b in per_patient), 'sync': per_patient_sync,
                          'coldStart': per_patient_cold},
           'facility': {'docBytes': len(facility_bytes), 'loadMs': load_ms, 'sync': facility_sync,
                        'coldStart': facility_cold}}
    print(f'granularity N={patients}: per-patient sync server {per_patient_sync["serverMs"]:.1f} ms, '
          f'facility sync server {facility_sync["serverMs"]:.1f} ms (doc {len(facility_bytes)} B, load {load_ms:.1f} ms)')
    return row


def main():
    RESULTS.mkdir(exist_ok=True)
    report = {'history': bench_history(), 'granularity': [bench_granularity(n) for n in (1000, 5000)]}
    (RESULTS / 'server.json').write_text(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
