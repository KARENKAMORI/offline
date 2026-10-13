"""End-to-end sync benchmark: offline devices reconnecting to the Django server.

Seeds a facility, starts `runserver` on a throwaway SQLite database, then runs
every device through the same phases concurrently:

    pull  - cold start: download every patient document
    edit  - offline: register patients, record visits, change statuses, and
            all devices edit the same "hot" patients (forced conflicts)
    sync  - reconnect: push local changes, pull what changed on the server
    sync  - a second pass so every device receives everyone else's changes
    digest- verify every device, the server document and the SQL rows agree

Usage (from the repo root):
    venv/bin/python benchmarks/run_e2e.py
    PATIENTS=5000 JS_DEVICES=10 PY_DEVICES=10 venv/bin/python benchmarks/run_e2e.py
"""
import json
import os
import shutil
import socket
import statistics
import subprocess
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BENCH = ROOT / 'benchmarks'
PYTHON = sys.executable

PATIENTS = int(os.environ.get('PATIENTS', 2000))
VISITS_PER_PATIENT = int(os.environ.get('VISITS_PER_PATIENT', 3))
JS_DEVICES = int(os.environ.get('JS_DEVICES', 5))
PY_DEVICES = int(os.environ.get('PY_DEVICES', 5))
LABEL = os.environ.get('LABEL', f'p{PATIENTS}-d{JS_DEVICES + PY_DEVICES}')


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


def seed(env):
    code = f"""
import random
from datetime import timedelta
from django.utils import timezone
from patients import crdt
from patients.models import Patient, Visit
rand = random.Random(7)
for i in range({PATIENTS}):
    p = Patient.objects.create(name=f'Seed patient {{i}}', location='Kibera', phone='0700000000',
                               head_of_household=rand.random() < 0.3)
    for v in range({VISITS_PER_PATIENT}):
        Visit.objects.create(patient=p, visit_type=rand.choice(['outpatient', 'follow_up', 'home_visit']),
                             timestamp=timezone.now() - timedelta(days=rand.randint(1, 365)))
    crdt.write_patient(p)
"""
    subprocess.run([PYTHON, 'manage.py', 'shell', '-v', '0', '-c', code], cwd=ROOT, env=env, check=True)


def run_device(kind, phase, server, state_dir, seed):
    cmd = (['node', str(BENCH / 'client' / 'device.mjs')] if kind == 'js'
           else [PYTHON, str(BENCH / 'device.py')]) + [phase, server, str(state_dir), str(seed)]
    out = subprocess.run(cmd, capture_output=True, text=True)
    if out.returncode:
        raise RuntimeError(f'{kind} device {seed} {phase} failed:\n{out.stderr[-2000:]}')
    return json.loads(out.stdout.strip().splitlines()[-1])


def run_phase(devices, phase, server):
    start = time.perf_counter()
    with ThreadPoolExecutor(len(devices)) as pool:
        results = list(pool.map(lambda d: run_device(d[0], phase, server, d[1], d[2]), devices))
    return results, (time.perf_counter() - start) * 1000


def summarise(results, wall_ms):
    def stat(key, kind=None):
        values = [r[key] for r in results if kind in (None, r['client'])]
        return {'p50': statistics.median(values), 'max': max(values), 'sum': sum(values)} if values else None
    return {
        'wallMs': wall_ms,
        'syncMs': stat('ms'), 'syncMsJs': stat('ms', 'js'), 'syncMsPy': stat('ms', 'py'),
        'roundTrips': stat('roundTrips'), 'docs': stat('docs'),
        'bytesUp': stat('bytesUp'), 'bytesDown': stat('bytesDown'), 'problems': stat('problems'),
        'stallResets': stat('resets'),
        'loadMs': stat('loadMs'),
    }


def server_digests(env):
    code = """
import json, sys
sys.path.insert(0, 'benchmarks')
from automerge.core import Document, extract
from device import digest
from patients.models import Patient, PatientDocument, Visit
docs = {str(r.patient_uuid): Document.load(bytes(r.data)) for r in PatientDocument.objects.all()}
visits = sum(len(extract(d).get('visits', {})) for d in docs.values())
print(json.dumps({'digest': {k: digest(d) for k, d in docs.items()},
                  'docVisits': visits, 'rowPatients': Patient.objects.count(), 'rowVisits': Visit.objects.count(),
                  'dbBytes': sum(len(r) for r in PatientDocument.objects.values_list('data', flat=True))}))
"""
    out = subprocess.run([PYTHON, 'manage.py', 'shell', '-v', '0', '-c', code], cwd=ROOT, env=env,
                         check=True, capture_output=True, text=True)
    return json.loads(out.stdout.strip().splitlines()[-1])


def main():
    run_dir = BENCH / '.runs' / LABEL
    shutil.rmtree(run_dir, ignore_errors=True)
    run_dir.mkdir(parents=True)
    env = {**os.environ, 'HMIS_DB_PATH': str(run_dir / 'db.sqlite3')}
    subprocess.run([PYTHON, 'manage.py', 'migrate', '-v', '0'], cwd=ROOT, env=env, check=True)
    t = time.perf_counter()
    seed(env)
    print(f'seeded {PATIENTS} patients in {time.perf_counter() - t:.1f}s', file=sys.stderr)

    port = free_port()
    server = f'http://127.0.0.1:{port}'
    proc = subprocess.Popen([PYTHON, 'manage.py', 'runserver', '--noreload', f'127.0.0.1:{port}'],
                            cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for _ in range(100):
            try:
                urllib.request.urlopen(f'{server}/api/sync/manifest/?since=2999-01-01T00:00:00Z', timeout=1)
                break
            except OSError:
                time.sleep(0.1)
        devices = ([('js', run_dir / f'js{i}', 100 + i) for i in range(JS_DEVICES)]
                   + [('py', run_dir / f'py{i}', 200 + i) for i in range(PY_DEVICES)])
        report = {'config': {'patients': PATIENTS, 'visitsPerPatient': VISITS_PER_PATIENT,
                             'jsDevices': JS_DEVICES, 'pyDevices': PY_DEVICES,
                             'edits': {k: int(os.environ.get(k, d)) for k, d in
                                       [('NEW_PATIENTS', 20), ('VISITS', 50), ('STATUS_EDITS', 20), ('HOT', 5)]}}}
        raw = {}
        for name, phase in [('pull', 'pull'), ('edit', 'edit'), ('reconnect', 'sync'), ('catchup', 'sync')]:
            results, wall_ms = run_phase(devices, phase, server)
            raw[name] = results
            report[name] = summarise(results, wall_ms) if phase != 'edit' else {
                'wallMs': wall_ms, 'docsEdited': [r['edited'] for r in results]}
            print(f'{name}: {wall_ms:.0f} ms wall', file=sys.stderr)

        device_digests, _ = run_phase(devices, 'digest', server)
        srv = server_digests(env)
        mismatched = sum(1 for d in device_digests for k, v in srv['digest'].items() if d['digest'].get(k) != v)
        report['convergence'] = {
            'serverDocs': len(srv['digest']),
            'deviceDocs': [len(d['digest']) for d in device_digests],
            'mismatchedDocs': mismatched,
            'rowPatients': srv['rowPatients'], 'rowVisits': srv['rowVisits'], 'docVisits': srv['docVisits'],
            'projectionMatches': srv['rowPatients'] == len(srv['digest']) and srv['rowVisits'] == srv['docVisits'],
            'serverDocBytes': srv['dbBytes'],
        }
    finally:
        proc.terminate()
        proc.wait()

    results_dir = BENCH / 'results'
    results_dir.mkdir(exist_ok=True)
    (results_dir / f'e2e-{LABEL}.json').write_text(json.dumps(report, indent=2))
    (results_dir / f'e2e-{LABEL}.raw.json').write_text(json.dumps(raw))
    print(json.dumps(report, indent=2))


if __name__ == '__main__':
    main()
