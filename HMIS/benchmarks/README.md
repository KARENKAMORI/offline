# Automerge sync for the HMIS: implementation and benchmark

Prototype of offline-first sync between the Django server and two offline apps
(Angular web, Flutter mobile), using Automerge CRDTs. Measured 2026-10-08 on one
laptop: Django `runserver`, SQLite, all clients on the same machine.

## How it works

### Data model

One Automerge document per patient, stored as bytes in `PatientDocument`:

```
{ patient: { name, phone, status, location, head_of_household, registered_at },
  visits:  { "<visit uuid>": { visit_type, timestamp, reason,
                               temperature_c, pulse_bpm, systolic_mmhg, diastolic_mmhg,
                               respiratory_rate, spo2_pct, weight_kg, deleted_at } } }
```

[`DOCUMENT_SCHEMA.md`](../DOCUMENT_SCHEMA.md) is the full contract. The visit
keys after `timestamp` are optional (older documents lack them). Vitals are flat
keys holding decimal strings, and a visit is deleted by setting `deleted_at`,
never by removing it from the map.

- **IDs are UUIDs generated on the device.** An offline device can't get an
  auto-increment id, so `Patient.uuid` and `Visit.uuid` were added (migration
  0002 backfills existing rows). The patient UUID is the document id.
- **Visits are a map keyed by UUID, not a list.** Two devices recording visits
  offline never fight over a list position; both visits survive.
- **Every field is a last-writer-wins scalar.** If two devices change `status`
  while offline, one value wins deterministically on every replica (Automerge
  orders concurrent writes by actor, not by wall clock). Different fields on
  the same patient merge without loss.
- **The document is the source of truth; the tables are a projection.** After
  every merge, `crdt.project()` rebuilds the `Patient`/`Visit` rows, so the
  existing REST API, admin and reports keep working. REST writes go the other
  way: `perform_create`/`perform_update` mirror the change into the document,
  so devices pick it up on their next sync.

### Sync protocol over HTTP

```
device                                     server
  │ GET /api/sync/manifest/?since=T           │  {uuid: heads} for docs changed since T
  │◄──────────────────────────────────────────┤  (minus a 2-minute overlap)
  │ pick docs: locally dirty, or heads differ │
  │ POST /api/sync/ {docs: {uuid: msg}}       │  per doc: load, receive, reply, save,
  ├──────────────────────────────────────────►│  project into Patient/Visit rows
  │◄──────────────────────────────────────────┤  {docs: {uuid: reply}, problems: {...}}
  │ repeat with docs that still have a message│  usually 2-4 rounds
```

- Up to 500 docs travel per request, so a device with 200 changed patients
  needs a few round trips, not 200.
- One bad document in a batch fails on its own; the rest still sync.
- The server can't reject a change once it has merged, because it's already
  in the device's history. Values that fail validation (for example
  `status: "deceased"`) are left out of the SQL projection and returned under
  `problems` so the app can show and fix them.

### Client libraries

| App | Library | Notes |
|---|---|---|
| Angular | `@automerge/automerge` 3.5.0 | Simulated by `client/device.mjs` with the same package. |
| Flutter | Rust crate `automerge` 0.12 via `flutter_rust_bridge` 2.13 | No usable Dart package exists (`automerge` on pub.dev is an empty 0.0.0 placeholder). Simulated by `device.py`, whose binding wraps the same Rust core. Not built here: the machine has no Rust toolchain. |
| Server | `automerge==1.0.0rc1` (official Python binding, pre-release) | The 0.1.x release on PyPI is an unrelated older package without the sync protocol. |

All three read and write the same binary format; JS ↔ Python round trips were
verified directly.

## Things every client must get right

These came out of the benchmark, not the docs. Two of them caused real
failures before they were fixed.

1. **Write strings as `ImmutableString` in JS.** In Automerge 3, assigning a
   plain string (`d.patient.status = "inactive"`) creates a collaborative Text
   object. The server and the Flutter side write scalar strings. Mixed, the
   same field changes CRDT type depending on who wrote it last, and Angular
   code gets `{val: "..."}` objects back where it expects strings. Use
   `new A.ImmutableString(v)` for every field in this schema. Save Text for
   free-text fields where character-level merging is wanted, such as clinical
   notes.

2. **Reset the sync state when a message repeats.** The server reloads each
   document from the database per request (needed for multiple workers). If a
   device sends changes before their dependencies (the sync protocol's Bloom
   filter gives occasional false positives by design), the server queues them
   in memory and loses them when the request ends. The device has already
   marked them as sent, so both sides exchange the same empty message forever.
   The fix: if a document's outgoing message is byte-identical to the one sent
   in the previous round, start a fresh `SyncState` for that document. In 12
   concurrent soak runs, the reset fired in 8 of them (1 to 5 times each);
   without it, those runs hang. Also cap rounds (20 here) so a bug fails loudly.

3. **Never create the `patient`/`visits` maps twice.** Only the device that
   registers a patient creates them. Everyone else starts from an empty doc and
   lets sync fill it. Two independent `put_object(ROOT, "patient")` calls make
   two different objects, and one silently wins.

4. **Duplicates are not conflicts.** If two devices both register the same
   real person offline, that's two patients with two UUIDs. A CRDT can't know
   they're the same person; that needs matching/merge logic (an MPI).

## Results

Raw numbers: `results/server.json`, `results/e2e-*.json`.

### End to end (`run_e2e.py`)

Each device, while offline: registers 20 patients, records 50 visits, changes
20 statuses, and edits the same 5 "hot" patients as every other device
(guaranteed conflicts). Then all devices reconnect at the same moment.

| | 2,000 patients, 10 devices | 5,000 patients, 20 devices |
|---|---|---|
| Cold start (pull everything), per device p50 | 13.0 s, 2.4 MB down, 9 requests | 65 s, 6.1 MB down, 21 requests |
| Reconnect (push ~100–130 dirty docs), p50 / max | 4.0 s / 6.1 s, 4–6 requests | 8.1 s / 12.8 s, 4–6 requests |
| Catch-up (pull everyone else's changes), p50 | 3.9 s, 0.7 MB down | 19 s, 1.3 MB down |
| Converged (every device = server = SQL rows) | yes, 2,200 docs, 6,550 visits | yes, 5,400 docs, 16,100 visits |
| Validation problems | 0 | 0 |

Angular (JS) and Flutter-stand-in (Python/Rust) clients performed about the
same; the wait is on the server.

### Server cost per document (`bench_server.py`)

| Patient document | Doc size | As JSON | Load | Server cost to sync 1 new visit |
|---|---|---|---|---|
| no visits | 279 B | 187 B | 0.01 ms | 0.05 ms |
| 10 visits | 683 B | 1.3 KB | 0.06 ms | 0.5 ms |
| 100 visits | 3.0 KB | 11 KB | 0.4 ms | 1.6 ms |
| 500 visits | 13.7 KB | 56 KB | 2.1 ms | 6.1 ms |
| 10 visits + 1,000 status edits | 734 B | 1.3 KB | 1.2 ms | 2.9 ms |
| 10 visits + 10,000 status edits | 838 B | 1.3 KB | 12 ms | 28 ms |

- Storage overhead isn't a concern: Automerge's compressed format comes in
  smaller than the plain JSON once a patient has a few visits.
- History costs CPU, not bytes. A field edited 10,000 times adds ~150 bytes
  but makes every load ~200× slower. Normal patient records won't get near
  that, but it's a reason not to put high-churn data (vitals streams, counters
  updated every second) in these documents.

### One document per patient vs one per facility

A device changed 10 patients and synced:

| Facility size | Per-patient docs: server time | One facility doc: server time | Facility doc size |
|---|---|---|---|
| 1,000 patients | 0.9 ms | 55 ms | 115 KB |
| 5,000 patients | 0.9 ms | 265 ms | 548 KB |

The facility document is rewritten on every sync from every device, so its
cost grows with the facility and every sync contends on one row. Per-patient
documents stay flat. The one place the facility document wins is cold start
bytes (116 KB vs 720 KB for 1,000 patients), because each small document has
fixed overhead.

## What I'd do next

1. **Add a snapshot endpoint for cold start.** Pulling 5,000 patients over the
   sync protocol took 65 s and 21 requests per device. A bulk download of saved
   document bytes (one archive, ~3 MB for 5,000 patients) skips the protocol
   entirely, then the device switches to incremental sync.
2. **Benchmark on Postgres with real workers.** SQLite with `BEGIN IMMEDIATE`
   serialises every sync request, including read-only ones. That, plus a single
   `runserver` process, is most of the cold-start and catch-up time. Postgres
   row locks (`select_for_update` is already in place) let different patients
   sync in parallel.
3. **Or remove the stall at its source.** A stateful sync server (in the style
   of automerge-repo) keeps documents and sync states in memory between rounds,
   so queued changes aren't lost. It's more infrastructure than the stateless
   HTTP endpoint, but clients would no longer need the sync-state reset.
4. **Before production:** authentication and tenant/facility scoping on both
   endpoints (they're open right now, like the rest of the prototype API), a
   build of the Flutter binding on a machine with Rust, and Automerge-JS
   persistence in IndexedDB for the Angular app.

## Running it

```bash
cd benchmarks/client && npm install && cd ../..
venv/bin/python manage.py test patients            # sync tests
venv/bin/python benchmarks/bench_server.py          # server microbenchmarks
venv/bin/python benchmarks/run_e2e.py               # 2,000 patients, 10 devices
PATIENTS=5000 JS_DEVICES=10 PY_DEVICES=10 venv/bin/python benchmarks/run_e2e.py
```

`run_e2e.py` uses a throwaway database under `benchmarks/.runs/` (via
`HMIS_DB_PATH`) and never touches `db.sqlite3`. Set `SYNC_TRACE=1` to dump
the stuck document and its message trace if a Python device's sync doesn't settle.
