import { HttpErrorResponse } from '@angular/common/http';
import { EnvironmentInjector, createEnvironmentInjector } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { loadAutomerge, type Automerge } from '../db/automerge';
import { ActivityService } from '../db/activity.service';
import { DocStore } from '../db/doc-store';
import { HMIS_DB, HmisDb } from '../db/hmis-db';
import { EMPTY_VITALS, type PatientInput, type VisitInput, type VisitType } from '../db/models';
import { PatientService } from '../db/patient.service';
import { VisitService } from '../db/visit.service';
import { NetworkStatus } from '../network-status';
import { ProfileService } from '../profile.service';
import { SYNC_CONFIG, SyncApi } from './sync-api';
import { SyncService } from './sync.service';
import { FakeServer } from './testing/fake-server';

const amina: PatientInput = {
  name: 'Amina Wanjiru',
  phone: '0700000001',
  status: 'active',
  location: 'Kibera',
  headOfHousehold: true,
};

function visit(visitType: VisitType, timestamp: string, more: Partial<VisitInput> = {}): VisitInput {
  return { ...EMPTY_VITALS, visitType, timestamp, reason: '', ...more };
}

async function waitFor(done: () => boolean, ms = 2_000): Promise<void> {
  const until = Date.now() + ms;
  while (!done()) {
    if (Date.now() > until) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** One offline device: its own IndexedDB and its own service instances, sharing one server. */
class Device {
  readonly db = new HmisDb(`hmis-test-${Math.random()}`);
  private readonly injector: EnvironmentInjector;

  constructor(server: FakeServer) {
    this.injector = createEnvironmentInjector(
      [
        { provide: HMIS_DB, useValue: this.db },
        { provide: SyncApi, useValue: server },
        {
          provide: SYNC_CONFIG,
          useValue: { apiBaseUrl: '', intervalMs: 1e9, debounceMs: 1e9, retryMs: [10, 20], timeoutMs: 1e9 },
        },
        DocStore,
        PatientService,
        VisitService,
        SyncService,
        NetworkStatus,
        ActivityService,
        ProfileService,
      ],
      TestBed.inject(EnvironmentInjector),
    );
  }

  get patients() { return this.injector.get(PatientService); }
  get visits() { return this.injector.get(VisitService); }
  get sync() { return this.injector.get(SyncService); }
  get store() { return this.injector.get(DocStore); }
  get network() { return this.injector.get(NetworkStatus); }
  get activity() { return this.injector.get(ActivityService); }

  async destroy(): Promise<void> {
    this.injector.destroy();
    await this.db.delete();
  }
}

describe('Offline storage and sync', () => {
  let A: Automerge;
  let server: FakeServer;
  let devices: Device[];
  const device = () => {
    const d = new Device(server);
    devices.push(d);
    return d;
  };

  beforeAll(async () => {
    A = await loadAutomerge();
  });

  beforeEach(() => {
    server = new FakeServer(A);
    devices = [];
  });

  afterEach(async () => {
    await Promise.all(devices.map((d) => d.destroy()));
  });

  it('registers, edits and records visits with no server at all', async () => {
    const chv = device();
    const id = await chv.patients.create(amina);
    const visitId = await chv.visits.create(id, visit('home_visit', '2026-10-08T09:00:00.000Z'));
    await chv.patients.update(id, { ...amina, status: 'inactive' });
    await chv.visits.update(visitId, visit('follow_up', '2026-10-08T09:00:00.000Z'));

    const p = await chv.patients.get(id);
    expect(p).toEqual(jasmine.objectContaining({ name: 'Amina Wanjiru', status: 'inactive', headOfHousehold: true }));
    expect((await chv.visits.get(visitId))?.visitType).toBe('follow_up');
    expect(await chv.db.dirty.count()).toBe(1);
    expect(server.docs.size).toBe(0);
  });

  it('writes the document in the shape the server expects', async () => {
    const chv = device();
    const id = await chv.patients.create(amina);
    await chv.visits.create(id, visit('outpatient', '2026-10-08T09:00:00.000Z'));
    await chv.sync.syncNow();

    const doc = server.read(id);
    expect(doc.patient.name).toBeInstanceOf(A.ImmutableString);
    expect(doc.patient.name.val).toBe('Amina Wanjiru');
    expect(doc.patient.head_of_household).toBeTrue();
    expect(doc.patient.registered_at.val).toMatch(/^\d{4}-\d\d-\d\dT/);
    const [stored] = Object.values(doc.visits);
    expect(stored.visit_type.val).toBe('outpatient');
  });

  it('uploads local changes, clears the pending flag and downloads them on another device', async () => {
    const chv = device();
    const clinic = device();
    const id = await chv.patients.create(amina);
    await chv.visits.create(id, visit('home_visit', '2026-10-08T09:00:00.000Z'));

    await chv.sync.syncNow();
    expect(chv.sync.phase()).toBe('idle');
    expect(await chv.db.dirty.count()).toBe(0);
    expect(chv.sync.lastSyncedAt()).not.toBeNull();

    await clinic.sync.syncNow();
    expect((await clinic.patients.get(id))?.name).toBe('Amina Wanjiru');
    expect((await firstValueFrom(clinic.visits.forPatient$(id))).map((v) => v.visitType)).toEqual(['home_visit']);
    expect(await clinic.db.dirty.count()).toBe(0);
  });

  it('merges concurrent offline edits and keeps both visits', async () => {
    const chv = device();
    const clinic = device();
    const id = await chv.patients.create(amina);
    await chv.sync.syncNow();
    await clinic.sync.syncNow();

    await chv.patients.update(id, { ...amina, phone: '0711111111' });
    await chv.visits.create(id, visit('home_visit', '2026-10-09T09:00:00.000Z'));
    await clinic.patients.update(id, { ...amina, status: 'suspended' });
    await clinic.visits.create(id, visit('outpatient', '2026-10-09T10:00:00.000Z'));

    await chv.sync.syncNow();
    await clinic.sync.syncNow();
    await chv.sync.syncNow();

    for (const d of [chv, clinic]) {
      expect(await d.patients.get(id)).toEqual(
        jasmine.objectContaining({ phone: '+254711111111', status: 'suspended' }),
      );
      const visits = await firstValueFrom(d.visits.forPatient$(id));
      expect(visits.map((v) => v.visitType)).toEqual(['outpatient', 'home_visit']);
    }
  });

  it('receives edits made on the server', async () => {
    const chv = device();
    const id = await chv.patients.create(amina);
    await chv.sync.syncNow();

    server.edit(id, (d, A) => (d.patient.status = new A.ImmutableString('inactive')));
    await chv.sync.syncNow();

    expect((await chv.patients.get(id))?.status).toBe('inactive');
    expect(await chv.db.dirty.count()).toBe(0);
  });

  it('keeps an edit made while a sync is in flight pending for the next sync', async () => {
    const chv = device();
    const id = await chv.patients.create(amina);
    let edited = false;
    server.beforeExchange = async () => {
      if (edited) return;
      edited = true;
      await chv.patients.update(id, { ...amina, location: 'Mathare' });
    };

    await chv.sync.syncNow();
    expect((await chv.patients.get(id))?.location).toBe('Mathare');
    expect(await chv.db.dirty.count()).toBe(1);

    server.beforeExchange = undefined;
    await chv.sync.syncNow();
    expect(await chv.db.dirty.count()).toBe(0);
    expect(server.read(id).patient.location.val).toBe('Mathare');
  });

  it('stores problems the server reports and clears them once fixed', async () => {
    const chv = device();
    const id = await chv.patients.create(amina);
    await chv.store.change(id, { kind: 'patient.update', summary: 'Patient: Amina Wanjiru' }, (d, A) => {
      d.patient.status = new A.ImmutableString('deceased');
    });

    await chv.sync.syncNow();
    expect(await firstValueFrom(chv.sync.problemsFor$(id))).toEqual([
      "patient.status: Value 'deceased' is not a valid choice.",
    ]);

    await chv.patients.update(id, amina);
    await chv.sync.syncNow();
    expect(await firstValueFrom(chv.sync.problemsFor$(id))).toEqual([]);
  });

  it('does nothing while offline and keeps changes pending', async () => {
    const chv = device();
    chv.network.online.set(false);
    spyOn(server, 'manifest').and.callThrough();
    await chv.patients.create(amina);

    await chv.sync.syncNow();

    expect(server.manifest).not.toHaveBeenCalled();
    expect(await chv.db.dirty.count()).toBe(1);
  });

  it('reports an unreachable server without losing local data', async () => {
    const chv = device();
    const id = await chv.patients.create(amina);
    spyOn(server, 'manifest').and.rejectWith(new Error('Server unreachable.'));

    await chv.sync.syncNow();

    expect(chv.sync.phase()).toBe('error');
    expect(chv.sync.lastError()).toBe('Server unreachable.');
    expect((await chv.patients.get(id))?.name).toBe('Amina Wanjiru');
    expect(await chv.db.dirty.count()).toBe(1);
  });

  it('round-trips reason and vitals through the document and the projection', async () => {
    const chv = device();
    const clinic = device();
    const id = await chv.patients.create(amina);
    const visitId = await chv.visits.create(
      id,
      visit('outpatient', '2026-10-08T09:00:00.000Z', {
        reason: '  Antenatal check ',
        temperatureC: '38.4',
        pulseBpm: '72',
        systolicMmhg: '120',
        diastolicMmhg: '80',
      }),
    );
    await chv.sync.syncNow();

    const stored = server.read(id).visits[visitId];
    expect(stored.reason?.val).toBe('Antenatal check');
    expect(stored.temperature_c).toBeInstanceOf(A.ImmutableString);
    expect(stored.temperature_c?.val).toBe('38.4');
    expect(stored.weight_kg?.val).toBe('');
    expect(stored.deleted_at?.val).toBe('');

    await clinic.sync.syncNow();
    expect(await clinic.visits.get(visitId)).toEqual(
      jasmine.objectContaining({
        reason: 'Antenatal check',
        temperatureC: '38.4',
        pulseBpm: '72',
        systolicMmhg: '120',
        diastolicMmhg: '80',
        spo2Pct: '',
        deletedAt: '',
      }),
    );
  });

  it('reads visits written before reason and vitals existed', async () => {
    const chv = device();
    const id = await chv.patients.create(amina);
    await chv.store.change(id, { kind: 'visit.create', summary: 'Visit: Amina Wanjiru' }, (d, A) => {
      d.visits['old-visit'] = {
        visit_type: new A.ImmutableString('home_visit'),
        timestamp: new A.ImmutableString('2026-10-01T09:00:00.000Z'),
      };
    });
    expect(await chv.visits.get('old-visit')).toEqual(
      jasmine.objectContaining({ visitType: 'home_visit', reason: '', temperatureC: '', deletedAt: '' }),
    );
  });

  it('only writes the keys that changed, so concurrent vitals edits both survive', async () => {
    const chv = device();
    const clinic = device();
    const id = await chv.patients.create(amina);
    const base = visit('outpatient', '2026-10-08T09:00:00.000Z');
    const visitId = await chv.visits.create(id, base);
    await chv.sync.syncNow();
    await clinic.sync.syncNow();

    await chv.visits.update(visitId, { ...base, temperatureC: '37.9' });
    await clinic.visits.update(visitId, { ...base, weightKg: '64.5' });
    await chv.sync.syncNow();
    await clinic.sync.syncNow();
    await chv.sync.syncNow();

    for (const d of [chv, clinic]) {
      expect(await d.visits.get(visitId)).toEqual(
        jasmine.objectContaining({ temperatureC: '37.9', weightKg: '64.5' }),
      );
    }
  });

  it('soft-deletes a visit: hidden from lists, kept in the document, synced as deleted_at', async () => {
    const chv = device();
    const clinic = device();
    const id = await chv.patients.create(amina);
    const visitId = await chv.visits.create(id, visit('outpatient', '2026-10-08T09:00:00.000Z'));
    await chv.sync.syncNow();
    await clinic.sync.syncNow();

    await chv.visits.delete(visitId);
    expect(await firstValueFrom(chv.visits.forPatient$(id))).toEqual([]);
    expect(await firstValueFrom(chv.visits.visits$)).toEqual([]);
    expect((await chv.visits.get(visitId))?.deletedAt).toMatch(/^\d{4}-\d\d-\d\dT/);

    await chv.sync.syncNow();
    expect(server.read(id).visits[visitId].deleted_at?.val).toMatch(/^\d{4}-/);
    await clinic.sync.syncNow();
    expect(await firstValueFrom(clinic.visits.forPatient$(id))).toEqual([]);

    await clinic.visits.restore(visitId);
    expect((await firstValueFrom(clinic.visits.forPatient$(id))).map((v) => v.id)).toEqual([visitId]);
  });

  it('commits a JSON message naming the device and what changed', async () => {
    const chv = device();
    await chv.store.setDeviceName('Clinic laptop');
    const id = await chv.patients.create(amina);
    const visitId = await chv.visits.create(id, visit('outpatient', '2026-10-08T09:00:00.000Z'));
    await chv.visits.update(visitId, visit('outpatient', '2026-10-08T09:00:00.000Z', { pulseBpm: '80' }));
    await chv.visits.delete(visitId);

    const row = await chv.db.docs.get(id);
    const messages = A.getAllChanges(A.load(row!.bytes)).map((c) => JSON.parse(A.decodeChange(c).message!));
    const { deviceId } = await chv.store.identity();
    expect(deviceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(messages).toEqual([
      { device_id: deviceId, device_name: 'Clinic laptop', kind: 'patient.create', summary: 'Household: Amina Wanjiru' },
      { device_id: deviceId, device_name: 'Clinic laptop', kind: 'visit.create', summary: 'Visit: Amina Wanjiru' },
      { device_id: deviceId, device_name: 'Clinic laptop', kind: 'visit.vitals', summary: 'Vitals: Amina Wanjiru' },
      { device_id: deviceId, device_name: 'Clinic laptop', kind: 'visit.delete', summary: 'Visit: Amina Wanjiru' },
    ]);
    expect(A.decodeChange(A.getAllChanges(A.load(row!.bytes))[0]).time).toBeGreaterThan(1.7e9);
  });
  it('shows offline when a sync gets no reply, and online once the server answers again', async () => {
    const chv = device();
    await chv.patients.create(amina);
    const manifest = spyOn(server, 'manifest').and.rejectWith(new HttpErrorResponse({ status: 0 }));

    await chv.sync.syncNow();
    expect(chv.sync.connection()).toBe('offline');
    expect(chv.sync.lastError()).toBe('Server unreachable.');

    manifest.and.callThrough();
    await chv.network.check();
    expect(chv.sync.connection()).toBe('online');
  });

  it('stays online when the server answers but refuses the sync', async () => {
    const chv = device();
    await chv.patients.create(amina);
    spyOn(server, 'manifest').and.rejectWith(new HttpErrorResponse({ status: 500 }));

    await chv.sync.syncNow();

    expect(chv.sync.connection()).toBe('online');
    expect(chv.sync.lastError()).toContain('error 500');
    expect(await chv.db.dirty.count()).toBe(1);
  });

  it('retries soon after a failed sync instead of waiting out the interval', async () => {
    const chv = device();
    await chv.patients.create(amina);
    // The network reports up before requests get through: the first sync fails.
    const manifest = spyOn(server, 'manifest').and.rejectWith(new Error('Server unreachable.'));
    manifest.and.callFake(() => {
      manifest.and.callThrough();
      return Promise.reject(new Error('Server unreachable.'));
    });

    chv.sync.start();
    await waitFor(() => chv.sync.lastSyncedAt() !== null);

    expect(manifest.calls.count()).toBe(2);
    expect(chv.sync.connection()).toBe('online');
    expect(await chv.db.dirty.count()).toBe(0);
  });

  it('records each sync in the history, and one line per outage while it keeps failing', async () => {
    const chv = device();
    await chv.patients.create(amina);
    await chv.sync.syncNow();
    let runs = await firstValueFrom(chv.activity.runs$);
    expect(runs.map((r) => [r.outcome, r.sent, r.detail])).toEqual([['done', 1, '1 change sent']]);

    const manifest = spyOn(server, 'manifest').and.rejectWith(new Error('Server unreachable.'));
    await chv.sync.syncNow();
    await chv.sync.syncNow();
    runs = await firstValueFrom(chv.activity.runs$);
    expect(runs.map((r) => r.outcome)).toEqual(['failed', 'done']);
    expect(chv.sync.phase()).toBe('error');

    manifest.and.callThrough();
    await chv.sync.syncNow();
    expect(chv.sync.connection()).toBe('online');
    expect(await firstValueFrom(chv.activity.runCounts$)).toEqual({ done: 1, merged: 0, failed: 1 });
  });

  it('lists pending changes in words and clears them once the server has them', async () => {
    const chv = device();
    const id = await chv.patients.create(amina);
    await chv.visits.create(id, visit('outpatient', '2026-10-08T09:00:00.000Z'));

    const pending = await firstValueFrom(chv.activity.pendingChanges$);
    expect(pending.map((c) => [c.verb, c.summary])).toEqual([
      ['added', 'Household: Amina Wanjiru'],
      ['added', 'Visit: Amina Wanjiru'],
    ]);

    await chv.sync.syncNow();
    expect(await chv.store.pendingChanges()).toEqual([]);
    await chv.patients.update(id, { ...amina, phone: '0711111111' });
    expect((await chv.store.pendingChanges()).map((c) => c.verb)).toEqual(['edited']);
  });

  it('tells the user when edits from another device merged into a record they changed', async () => {
    const chv = device();
    const clinic = device();
    await clinic.store.setDeviceName('Clinic laptop');
    const id = await chv.patients.create(amina);
    await chv.sync.syncNow();
    await clinic.sync.syncNow();

    await clinic.patients.update(id, { ...amina, location: 'Mathare' });
    await clinic.sync.syncNow();
    await chv.patients.update(id, { ...amina, phone: '0711111111' });
    await chv.sync.syncNow();

    const notices = await firstValueFrom(chv.activity.notices$);
    expect(notices.map((n) => [n.title, n.body])).toEqual([
      ['Merged a change from Clinic laptop', "Amina Wanjiru's record now has both edits."],
    ]);
    expect((await firstValueFrom(chv.activity.runs$))[0].outcome).toBe('merged');

    await chv.activity.dismissNotice(notices[0].id!);
    expect(await firstValueFrom(chv.activity.notices$)).toEqual([]);
  });

  it('shows the losing device its replaced edit and lets it re-enter its value', async () => {
    const chv = device();
    const clinic = device();
    const id = await chv.patients.create(amina);
    await chv.sync.syncNow();
    await clinic.sync.syncNow();

    await chv.patients.update(id, { ...amina, location: 'Mathare' });
    await clinic.patients.update(id, { ...amina, location: 'Kawangware' });
    await chv.sync.syncNow();
    await clinic.sync.syncNow();
    await chv.sync.syncNow();

    const [chvReplaced, clinicReplaced] = await Promise.all(
      [chv, clinic].map((d) => firstValueFrom(d.activity.replaced$)),
    );
    // Both see the same winner; only the device whose value lost is told.
    expect(chvReplaced.length + clinicReplaced.length).toBe(1);
    const loser = chvReplaced.length ? chv : clinic;
    const winner = loser === chv ? clinic : chv;
    const [edit] = chvReplaced.length ? chvReplaced : clinicReplaced;
    expect(edit).toEqual(jasmine.objectContaining({ patientName: 'Amina Wanjiru', path: 'patient', key: 'location' }));
    expect((await loser.patients.get(id))?.location).toBe(edit.kept);

    await loser.activity.resolve(edit, true);
    await loser.sync.syncNow();
    await winner.sync.syncNow();
    for (const d of [chv, clinic]) {
      expect((await d.patients.get(id))?.location).toBe(edit.mine);
      expect(await firstValueFrom(d.activity.replaced$)).toEqual([]);
    }
  });

  it('saves the phone normalised and never writes merged_into', async () => {
    const chv = device();
    const id = await chv.patients.create({ ...amina, phone: '0712 111-222' });
    await chv.patients.update(id, { ...amina, phone: '00254712111333' });
    await chv.sync.syncNow();

    const doc = server.read(id);
    expect(doc.patient.phone.val).toBe('+254712111333');
    expect('merged_into' in doc.patient).toBeFalse();
    expect((await chv.patients.get(id))?.mergedInto).toBe('');
  });

  it('hides a patient the server merged and shows the one it was merged into', async () => {
    const chv = device();
    const clinic = device();
    // The same person registered on two devices while offline.
    const canonical = await clinic.patients.create(amina);
    await clinic.visits.create(canonical, visit('outpatient', '2026-10-08T09:00:00.000Z'));
    const duplicate = await chv.patients.create({ ...amina, name: 'amina  WANJIRU', phone: '0700 000 001' });
    const copied = await chv.visits.create(duplicate, visit('home_visit', '2026-10-09T09:00:00.000Z'));
    await clinic.sync.syncNow();
    await chv.sync.syncNow();

    server.merge(duplicate, canonical);
    await chv.sync.syncNow();

    expect((await chv.patients.get(duplicate))?.mergedInto).toBe(canonical);
    expect((await firstValueFrom(chv.patients.patients$)).map((p) => p.id)).toEqual([canonical]);
    expect((await firstValueFrom(chv.patients.allPatients$)).length).toBe(2);
    expect(await chv.patients.canonicalId(duplicate)).toBe(canonical);
    // The copied visit is listed once, under the patient it was merged into.
    const visits = await firstValueFrom(chv.visits.visits$);
    expect(visits.map((v) => [v.visitType, v.patientId])).toEqual([
      ['home_visit', canonical],
      ['outpatient', canonical],
    ]);
    expect((await chv.visits.get(copied))?.patientId).toBe(canonical);
  });

  it('writes a visit for a merged patient into the patient it was merged into', async () => {
    const chv = device();
    const canonical = await chv.patients.create(amina);
    const duplicate = await chv.patients.create(amina);
    await chv.sync.syncNow();
    server.merge(duplicate, canonical);
    await chv.sync.syncNow();

    const visitId = await chv.visits.create(duplicate, visit('follow_up', '2026-10-10T09:00:00.000Z'));
    expect((await chv.visits.get(visitId))?.patientId).toBe(canonical);
    await chv.sync.syncNow();
    expect(server.read(canonical).visits[visitId]?.visit_type.val).toBe('follow_up');
    expect(server.read(duplicate).visits[visitId]).toBeUndefined();
  });

  it('keeps a merged patient whose canonical record has not downloaded, and writes to it', async () => {
    const chv = device();
    const duplicate = await chv.patients.create(amina);
    await chv.sync.syncNow();
    server.edit(duplicate, (d, A) => (d.patient.merged_into = new A.ImmutableString('not-on-this-device')));
    // The record it was merged into is not on this device.
    await chv.sync.syncNow();

    expect((await chv.patients.get(duplicate))?.mergedInto).toBe('not-on-this-device');
    expect(await chv.patients.canonicalId(duplicate)).toBe(duplicate);
    const visitId = await chv.visits.create(duplicate, visit('outpatient', '2026-10-10T09:00:00.000Z'));
    expect((await chv.visits.get(visitId))?.patientId).toBe(duplicate);
  });

  it('stops following merged_into at a cycle', async () => {
    const chv = device();
    const a = await chv.patients.create(amina);
    const b = await chv.patients.create(amina);
    await chv.sync.syncNow();
    server.edit(a, (d, A) => (d.patient.merged_into = new A.ImmutableString(b)));
    server.edit(b, (d, A) => (d.patient.merged_into = new A.ImmutableString(a)));
    await chv.sync.syncNow();

    expect(await chv.patients.canonicalId(a)).toBe(b);
    expect(await chv.patients.canonicalId(b)).toBe(a);
  });

  it('finds unmerged patients with the same normalised phone', async () => {
    const chv = device();
    const mother = await chv.patients.create(amina);
    await chv.patients.create({ ...amina, name: 'Baraka Otieno', phone: '+254700000001' });
    await chv.patients.create({ ...amina, name: 'Chebet Kirui', phone: '0700000002' });

    const found = await chv.patients.samePhone('0700 000-001', 'wanjiru amina');
    expect(found.sameName.map((p) => p.id)).toEqual([mother]);
    expect(found.otherName.map((p) => p.name)).toEqual(['Baraka Otieno']);
    expect(await chv.patients.samePhone('', 'Amina Wanjiru')).toEqual({ sameName: [], otherName: [] });
  });
});
