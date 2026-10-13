import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Router, provideRouter } from '@angular/router';
import { HMIS_DB, HmisDb } from '../../core/db/hmis-db';
import type { PatientInput } from '../../core/db/models';
import { PatientService } from '../../core/db/patient.service';
import { SyncApi } from '../../core/sync/sync-api';
import { PatientForm } from './patient-form';

const amina: PatientInput = {
  name: 'Amina Wanjiru',
  phone: '0700000001',
  status: 'active',
  location: 'Kibera',
  headOfHousehold: true,
};

describe('PatientForm duplicate warning', () => {
  let db: HmisDb;
  let fixture: ComponentFixture<PatientForm>;
  let navigate: jasmine.Spy;
  const el = () => fixture.nativeElement as HTMLElement;

  beforeEach(async () => {
    db = new HmisDb(`hmis-test-${Math.random()}`);
    TestBed.configureTestingModule({
      imports: [PatientForm],
      // The app bar shows sync status; nothing here syncs.
      providers: [provideRouter([]), { provide: HMIS_DB, useValue: db }, { provide: SyncApi, useValue: {} }],
    });
    navigate = spyOn(TestBed.inject(Router), 'navigate').and.resolveTo(true);
    fixture = TestBed.createComponent(PatientForm);
    fixture.detectChanges();
    await fixture.whenStable();
  });

  afterEach(async () => {
    fixture.destroy();
    await db.delete();
  });

  function fill(name: string, phone: string, location = 'Kibera'): void {
    for (const [control, value] of Object.entries({ name, phone, location })) {
      const input = el().querySelector<HTMLInputElement>(`input[formcontrolname="${control}"]`)!;
      input.value = value;
      input.dispatchEvent(new Event('input'));
    }
    fixture.detectChanges();
  }

  function button(text: string): HTMLButtonElement {
    const found = [...el().querySelectorAll('button')].find((b) => b.textContent?.trim() === text);
    if (!found) throw new Error(`No "${text}" button`);
    return found;
  }

  /** IndexedDB work is not tracked by the zone, so poll until the screen shows the result. */
  async function until(done: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !done(); i++) {
      await new Promise((r) => setTimeout(r, 10));
      fixture.detectChanges();
    }
    expect(done()).withContext('timed out').toBeTrue();
  }

  it('offers to open the patient already registered with the same name and number', async () => {
    const existing = await TestBed.inject(PatientService).create(amina);
    fill('wanjiru AMINA', '0700 000 001');
    button('Register patient').click();

    await until(() => !!el().querySelector('[role="alert"]'));
    expect(el().querySelector('[role="alert"]')?.textContent).toContain(
      'Amina Wanjiru (+254700000001) is already registered.',
    );
    expect(await db.patients.count()).toBe(1);

    button('Open existing').click();
    await until(() => navigate.calls.count() > 0);
    expect(navigate).toHaveBeenCalledWith(['/patients', existing], { replaceUrl: true });

    button('Register anyway').click();
    await until(() => navigate.calls.count() > 1);
    expect(await db.patients.count()).toBe(2);
  });

  it('notes who else uses the number, then registers on Continue', async () => {
    await TestBed.inject(PatientService).create(amina);
    fill('Baraka Otieno', '+254700000001');
    button('Register patient').click();

    await until(() => !!el().querySelector('[role="alert"]'));
    expect(el().querySelector('[role="alert"]')?.textContent).toContain(
      'This number is also used by Amina Wanjiru.',
    );
    button('Continue').click();
    await until(() => navigate.calls.count() > 0);
    expect(await db.patients.count()).toBe(2);
  });

  it('registers straight away when no patient shares the number', async () => {
    await TestBed.inject(PatientService).create(amina);
    fill('Amina Wanjiru', '0700000002');
    button('Register patient').click();

    await until(() => navigate.calls.count() > 0);
    expect(el().querySelector('[role="alert"]')).toBeNull();
    expect(await db.patients.count()).toBe(2);
  });
});
