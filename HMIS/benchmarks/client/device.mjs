// Simulated Angular offline device. Uses @automerge/automerge, the same package
// an Angular app would import. Docs persist to disk between phases the way an
// app would persist them to IndexedDB.
//
//   node device.mjs <phase> <server> <stateDir> [seed]
//   phases: pull | edit | sync | digest
import * as A from "@automerge/automerge";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [phase, server, dir, seed = "1"] = process.argv.slice(2);
const BATCH = 500;
// A sync normally settles in 2-4 rounds; a client must never loop forever.
const MAX_ROUNDS = 20;
const STATUSES = ["active", "inactive", "suspended"];
const VISIT_TYPES = ["outpatient", "inpatient", "follow_up", "home_visit"];
const cfg = {
  newPatients: +(process.env.NEW_PATIENTS ?? 20),
  visits: +(process.env.VISITS ?? 50),
  statusEdits: +(process.env.STATUS_EDITS ?? 20),
  hot: +(process.env.HOT ?? 5),
};

const docsDir = join(dir, "docs");
mkdirSync(docsDir, { recursive: true });
const metaPath = join(dir, "meta.json");
// Every field in the schema is a last-writer-wins value. A plain JS string
// would become a collaborative Text object, a different CRDT type from what the
// server and the Flutter app write, so scalar strings go in as ImmutableString.
const str = (v) => new A.ImmutableString(v);
const meta = existsSync(metaPath) ? JSON.parse(readFileSync(metaPath)) : { since: null, dirty: [] };

function rng(s) {
  let a = Number(s) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function loadAll() {
  const docs = new Map();
  for (const f of readdirSync(docsDir)) docs.set(f.slice(0, -3), A.load(readFileSync(join(docsDir, f))));
  return docs;
}
const saveDoc = (id, doc) => writeFileSync(join(docsDir, `${id}.am`), A.save(doc));
const saveMeta = () => writeFileSync(metaPath, JSON.stringify(meta));
const headsKey = (doc) => [...A.getHeads(doc)].sort().join(",");

async function syncDocs(docs, ids) {
  const m = { roundTrips: 0, bytesUp: 0, bytesDown: 0, docs: ids.length, problems: 0, resets: 0 };
  const states = new Map(ids.map((id) => [id, A.initSyncState()]));
  const lastSent = new Map();
  let pending = ids;
  for (let round = 1; pending.length; round++) {
    if (round > MAX_ROUNDS) {
      const stuck = pending.slice(0, 3).map((id) => ({ id, heads: A.getHeads(docs.get(id)) }));
      throw new Error(`sync did not settle after ${MAX_ROUNDS} rounds: ${pending.length} docs, e.g. ${JSON.stringify(stuck)}`);
    }
    const outgoing = {};
    for (const id of pending) {
      let [state, msg] = A.generateSyncMessage(docs.get(id), states.get(id));
      // The server reloads each doc per request, so changes it had to queue
      // (a dependency was missing) are dropped, while this side has marked
      // them as sent. That shows up as the same message repeating: reset the
      // doc's sync state so everything the server lacks is offered again.
      if (msg && lastSent.get(id) === Buffer.from(msg).toString("base64")) {
        [state, msg] = A.generateSyncMessage(docs.get(id), A.initSyncState());
        m.resets++;
      }
      states.set(id, state);
      if (msg) lastSent.set(id, outgoing[id] = Buffer.from(msg).toString("base64"));
    }
    const keys = Object.keys(outgoing);
    if (!keys.length) break;
    for (let i = 0; i < keys.length; i += BATCH) {
      const body = JSON.stringify({ docs: Object.fromEntries(keys.slice(i, i + BATCH).map((k) => [k, outgoing[k]])) });
      const res = await fetch(`${server}/api/sync/`, { method: "POST", headers: { "content-type": "application/json" }, body });
      const text = await res.text();
      if (!res.ok) throw new Error(`sync ${res.status}: ${text.slice(0, 300)}`);
      m.roundTrips++; m.bytesUp += body.length; m.bytesDown += text.length;
      const reply = JSON.parse(text);
      m.problems += Object.keys(reply.problems).length;
      for (const [id, b64] of Object.entries(reply.docs)) {
        if (!b64) continue;
        const [doc, state] = A.receiveSyncMessage(docs.get(id), states.get(id), Buffer.from(b64, "base64"));
        docs.set(id, doc); states.set(id, state);
      }
    }
    pending = keys;
  }
  return m;
}

async function sync(docs, full) {
  const t0 = performance.now();
  const q = !full && meta.since ? `?since=${encodeURIComponent(meta.since)}` : "";
  const res = await fetch(`${server}/api/sync/manifest/${q}`);
  const manifest = await res.json();
  const manifestBytes = +(res.headers.get("content-length") ?? 0) || JSON.stringify(manifest).length;
  const ids = new Set(meta.dirty);
  for (const [id, heads] of Object.entries(manifest.docs)) {
    if (!docs.has(id)) docs.set(id, A.init());
    if (headsKey(docs.get(id)) !== [...heads].sort().join(",")) ids.add(id);
  }
  const m = await syncDocs(docs, [...ids]);
  m.ms = performance.now() - t0;
  m.bytesDown += manifestBytes; m.roundTrips++;
  for (const id of ids) saveDoc(id, docs.get(id));
  meta.since = manifest.server_time; meta.dirty = []; saveMeta();
  return m;
}

function edit(docs) {
  const rand = rng(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const ids = [...docs.keys()].sort();
  const hot = ids.slice(0, cfg.hot);
  const dirty = new Set(meta.dirty);
  const change = (id, fn) => { docs.set(id, A.change(docs.get(id), fn)); dirty.add(id); };
  const addVisit = (d) => { d.visits[randomUUID()] = { visit_type: str(pick(VISIT_TYPES)), timestamp: str(new Date().toISOString()) }; };

  for (let i = 0; i < cfg.newPatients; i++) {
    const id = randomUUID();
    docs.set(id, A.from({
      patient: { name: str(`JS patient ${seed}-${i}`), phone: str(""), status: str("active"), location: str("Kibera"),
                 head_of_household: rand() < 0.3, registered_at: str(new Date().toISOString()) },
      visits: {},
    }));
    dirty.add(id);
  }
  for (let i = 0; i < cfg.visits; i++) change(pick(ids), addVisit);
  for (let i = 0; i < cfg.statusEdits; i++) change(pick(ids), (d) => { d.patient.status = str(pick(STATUSES)); });
  // Every device edits the same hot patients: guaranteed concurrent conflicts.
  for (const id of hot) change(id, (d) => { d.patient.status = str(pick(STATUSES)); d.patient.phone = str(`07${seed.padStart(8, "0")}`); addVisit(d); });

  for (const id of dirty) saveDoc(id, docs.get(id));
  meta.dirty = [...dirty]; saveMeta();
  return { edited: dirty.size };
}

function digest(docs) {
  const out = {};
  for (const [id, doc] of docs) out[id] = createHash("sha256").update(canonical(A.toJS(doc))).digest("hex");
  return out;
}
function canonical(v) {
  if (v instanceof A.ImmutableString) return JSON.stringify(v.val);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

const t0 = performance.now();
const docs = loadAll();
const loadMs = performance.now() - t0;
let result;
if (phase === "pull") result = await sync(docs, true);
else if (phase === "sync") result = await sync(docs, false);
else if (phase === "edit") result = edit(docs);
else if (phase === "digest") result = digest(docs);
else throw new Error(`unknown phase ${phase}`);
console.log(JSON.stringify({ client: "js", phase, loadMs, docCount: docs.size, ...(phase === "digest" ? { digest: result } : result) }));
