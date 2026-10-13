import { Component, inject, input, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { Router } from '@angular/router';
import { LucideAngularModule, MapPin, Phone, User } from 'lucide-angular';
import { merge } from 'rxjs';
import {
  PATIENT_STATUSES,
  statusLabel,
  type Patient,
  type PatientInput,
  type PatientStatus,
} from '../../core/db/models';
import { PatientService } from '../../core/db/patient.service';
import { normalizePhone } from '../../core/identity';
import { NavHistory } from '../../shared/nav-history';
import { EmptyState } from '../../shared/ui/empty-state';
import { FieldBar } from '../../shared/ui/field-bar';
import { Toast } from '../../shared/ui/toast';

/** Registers a patient, or edits one (patient_form.dart). */
@Component({
  selector: 'app-patient-form',
  imports: [ReactiveFormsModule, LucideAngularModule, FieldBar, EmptyState],
  template: `
    <app-field-bar [title]="id() ? 'Edit patient' : 'Register patient'" [back]="id() ? '/patients/' + id() : '/patients'" />
    @if (notFound()) {
      <app-empty-state [icon]="User" message="This patient is not on this device." />
    } @else {
      <form class="screen" [formGroup]="form" (ngSubmit)="save()" novalidate>
        <div class="field">
          <label class="input input-labelled" [class.invalid]="invalid('name')">
            <span class="row">
              <lucide-icon [img]="User" [size]="22" />
              <span class="grow">
                <span class="float">Full name</span>
                <input formControlName="name" autocomplete="off" maxlength="200" autocapitalize="words" />
              </span>
            </span>
          </label>
          @if (invalid('name')) {
            <span class="error-text">Enter the patient’s name</span>
          }
          <span class="counter num">{{ form.controls.name.value.length }}/200</span>
        </div>

        <div class="field">
          <label class="input input-labelled" [class.invalid]="invalid('phone')">
            <span class="row">
              <lucide-icon [img]="Phone" [size]="22" />
              <span class="grow">
                <span class="float">Phone (optional)</span>
                <input formControlName="phone" type="tel" inputmode="tel" placeholder="e.g. 0712 345678" />
              </span>
            </span>
          </label>
          @if (invalid('phone')) {
            <span class="error-text">Enter a valid phone number</span>
          }
        </div>

        <div class="field gap-top">
          <label class="input input-labelled" [class.invalid]="invalid('location')">
            <span class="row">
              <lucide-icon [img]="MapPin" [size]="22" />
              <span class="grow">
                <span class="float">Location</span>
                <input formControlName="location" placeholder="Village, ward or estate" maxlength="200" />
              </span>
            </span>
          </label>
          @if (invalid('location')) {
            <span class="error-text">Enter where the patient lives</span>
          }
          <span class="counter num">{{ form.controls.location.value.length }}/200</span>
        </div>

        <fieldset>
          <legend class="title-medium">Status</legend>
          <div class="segmented">
            @for (s of statuses(); track s) {
              <label class="chip">
                <input type="radio" formControlName="status" [value]="s" />
                {{ label(s) }}
              </label>
            }
          </div>
        </fieldset>

        <label class="card switch-tile">
          <span class="text">
            <span class="title">Head of household</span><br />
            <span class="body-medium">This patient heads their household</span>
          </span>
          <input type="checkbox" role="switch" formControlName="headOfHousehold" />
        </label>

        <div class="gap-24"></div>
        @if (warning(); as w) {
          <div class="panel panel-amber" role="alert">
            @if (w.existing) {
              <p class="panel-title">{{ w.message }}</p>
              <div class="warning-actions">
                <button type="button" class="btn btn-filled" (click)="openExisting(w.existing)">Open existing</button>
                <button type="button" class="btn btn-outlined" [disabled]="saving()" (click)="save(true)">
                  Register anyway
                </button>
              </div>
            } @else {
              <p>{{ w.message }}</p>
              <div class="warning-actions">
                <button type="button" class="btn btn-filled" [disabled]="saving()" (click)="save(true)">Continue</button>
              </div>
            }
          </div>
        } @else {
          <button type="submit" class="btn btn-filled" [disabled]="saving()">
            {{ id() ? 'Save changes' : 'Register patient' }}
          </button>
        }
      </form>
    }
  `,
  styles: `
    .grow { flex: 1; display: flex; flex-direction: column; }
    .float { font-size: 13px; color: var(--muted); }
    .input-labelled input { padding: 2px 0 4px; }
    .input-labelled .row { gap: 12px; }
    .gap-top { margin-top: 8px; }
    fieldset { border: 0; padding: 0; margin: 8px 0 16px; }
    legend { padding: 0 0 8px; }
    .warning-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
  `,
})
export class PatientForm implements OnInit {
  /** Bound from the :id route param; absent when registering. */
  readonly id = input<string>();

  private readonly service = inject(PatientService);
  private readonly router = inject(Router);
  private readonly nav = inject(NavHistory);
  private readonly toast = inject(Toast);

  // A synced value outside the known statuses stays selectable so saving other fields
  // doesn't silently change it.
  protected readonly statuses = signal<string[]>([...PATIENT_STATUSES]);
  protected readonly saving = signal(false);
  protected readonly notFound = signal(false);
  /** Shown before registering a patient whose phone number is already on this device. */
  protected readonly warning = signal<DuplicateWarning | null>(null);
  protected readonly label = statusLabel;

  protected readonly form = inject(NonNullableFormBuilder).group({
    name: ['', [Validators.required, Validators.pattern(/\S/), Validators.maxLength(200)]],
    phone: ['', Validators.pattern(/^\s*\+?[0-9\s\-().]{7,25}\s*$/)],
    status: ['active' as string, Validators.required],
    location: ['', [Validators.required, Validators.pattern(/\S/), Validators.maxLength(200)]],
    headOfHousehold: [false],
  });

  constructor() {
    // The warning was about the name and number as they were.
    merge(this.form.controls.name.valueChanges, this.form.controls.phone.valueChanges)
      .pipe(takeUntilDestroyed())
      .subscribe(() => this.warning.set(null));
  }

  async ngOnInit(): Promise<void> {
    const id = this.id();
    if (!id) return;
    const patient = await this.service.get(id);
    if (!patient) {
      this.notFound.set(true);
      return;
    }
    if (!(PATIENT_STATUSES as readonly string[]).includes(patient.status)) {
      this.statuses.update((s) => [...s, patient.status]);
    }
    this.form.setValue({
      name: patient.name,
      phone: patient.phone,
      status: patient.status,
      location: patient.location,
      headOfHousehold: patient.headOfHousehold,
    });
  }

  protected invalid(name: 'name' | 'phone' | 'location'): boolean {
    const c = this.form.controls[name];
    return c.invalid && (c.touched || c.dirty);
  }

  /** `confirmed` once the user has seen the duplicate warning and chose to register anyway. */
  protected async save(confirmed = false): Promise<void> {
    // Checked as it will be saved, so 0712-111-222 and (0712) 111.222 are accepted.
    const digits = normalizePhone(this.form.controls.phone.value);
    if (digits && !/^\+?[0-9]{7,15}$/.test(digits)) this.form.controls.phone.setErrors({ pattern: true });
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    const value = this.form.getRawValue();
    const input = { ...value, status: value.status as PatientStatus };
    try {
      const id = this.id();
      if (!id && !confirmed) {
        const warning = await this.duplicateWarning(input);
        if (warning) {
          this.warning.set(warning);
          return;
        }
      }
      if (id) {
        await this.service.update(id, input);
        this.nav.back(`/patients/${id}`);
      } else {
        const created = await this.service.create(input);
        await this.router.navigate(['/patients', created], { replaceUrl: true });
      }
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.saving.set(false);
    }
  }

  /** Unmerged patients on this device with the same normalised phone (HMIS/DOCUMENT_SCHEMA.md). */
  private async duplicateWarning(input: PatientInput): Promise<DuplicateWarning | null> {
    const { sameName, otherName } = await this.service.samePhone(input.phone, input.name);
    const [existing] = sameName;
    if (existing) {
      return { message: `${existing.name} (${existing.phone}) is already registered.`, existing };
    }
    if (otherName.length) {
      return { message: `This number is also used by ${listNames(otherName.map((p) => p.name))}.` };
    }
    return null;
  }

  protected async openExisting(patient: Patient): Promise<void> {
    await this.router.navigate(['/patients', patient.id], { replaceUrl: true });
  }

  protected readonly User = User;
  protected readonly Phone = Phone;
  protected readonly MapPin = MapPin;
}

interface DuplicateWarning {
  message: string;
  /** Set when a patient with the same name and number exists, to offer opening it. */
  existing?: Patient;
}

/** "Amina", "Amina and Baraka", "Amina, Baraka and Chebet". */
function listNames(names: string[]): string {
  return names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
