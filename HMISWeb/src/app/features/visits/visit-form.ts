import { Component, computed, inject, input, OnInit, signal, viewChild } from '@angular/core';
import {
  AbstractControl,
  NonNullableFormBuilder,
  ReactiveFormsModule,
  ValidatorFn,
  Validators,
} from '@angular/forms';
import { Check, ChevronRight, Clock, LucideAngularModule, NotebookPen, Trash2 } from 'lucide-angular';
import {
  EMPTY_VITALS,
  REASON_MAX_LENGTH,
  VISIT_TYPES,
  VITAL_FIELDS,
  visitTypeLabel,
  vitalError,
  type Patient,
  type VitalField,
  type VitalKey,
  type VisitInput,
  type VisitType,
} from '../../core/db/models';
import { PatientService } from '../../core/db/patient.service';
import { VisitService } from '../../core/db/visit.service';
import { fromDateTimeLocal, toDateTimeLocal } from '../../core/util/datetime';
import { NavHistory } from '../../shared/nav-history';
import { Avatar } from '../../shared/ui/avatar';
import { ConfirmDialog } from '../../shared/ui/confirm-dialog';
import { EmptyState } from '../../shared/ui/empty-state';
import { FieldBar } from '../../shared/ui/field-bar';
import { Toast } from '../../shared/ui/toast';
import { PatientPicker } from './patient-picker';

function vitalValidator(field: VitalField): ValidatorFn {
  return (c: AbstractControl) => (vitalError(field, String(c.value ?? '')) ? { range: true } : null);
}

/** Records a new visit, or edits, deletes or restores one (visit_form.dart). */
@Component({
  selector: 'app-visit-form',
  imports: [ReactiveFormsModule, LucideAngularModule, FieldBar, Avatar, EmptyState, PatientPicker, ConfirmDialog],
  template: `
    <app-field-bar [title]="id() ? 'Visit' : 'Record visit'" [back]="backTo()">
      @if (id() && !deleted() && !notFound()) {
        <button type="button" class="btn icon-btn" aria-label="Delete visit" title="Delete visit" (click)="confirmDelete.open()">
          <lucide-icon [img]="Trash2" [size]="22" />
        </button>
      }
    </app-field-bar>

    @if (notFound()) {
      <app-empty-state [icon]="NotebookPen" message="This visit is not on this device." />
    } @else {
      <form class="screen" [formGroup]="form" (ngSubmit)="save()" novalidate>
        @if (deleted()) {
          <div class="panel panel-red">
            <p class="panel-title">This visit was deleted</p>
            <p class="restore-text">It is hidden from lists. Restore it to show it again on every device.</p>
            <button type="button" class="btn btn-outlined" (click)="restore()">Restore visit</button>
          </div>
        }

        <div class="patient-col">
        <h2 class="field-label">Patient</h2>
        <button type="button" class="card tile patient" [disabled]="!!id()" (click)="picker.open()">
          @if (patientName()) { <app-avatar [name]="patientName()!" /> }
          <span class="text title-medium" [class.placeholder]="!patientName()">{{ patientName() ?? 'Choose a patient' }}</span>
          @if (!id()) { <lucide-icon [img]="ChevronRight" [size]="24" class="chev" /> }
        </button>
        @if (patientMissing()) { <span class="error-text">Choose a patient.</span> }
        </div>

        <div class="details">

        <h2 class="field-label" id="type-label">Visit type</h2>
        <div class="chips" role="radiogroup" aria-labelledby="type-label">
          @for (t of types; track t) {
            <label class="chip">
              <input type="radio" formControlName="visitType" [value]="t" />
              <lucide-icon [img]="Check" [size]="18" />
              {{ typeLabel(t) }}
            </label>
          }
        </div>

        <h2 class="field-label"><label for="visit-time">Date and time</label></h2>
        <div class="card tile time">
          <lucide-icon [img]="Clock" [size]="24" />
          <input id="visit-time" class="text" type="datetime-local" formControlName="timestamp" />
        </div>

        <h2 class="field-label"><label for="reason">Reason</label></h2>
        <div class="field">
          <div class="input" [class.disabled]="deleted()">
            <input id="reason" formControlName="reason" [maxlength]="reasonMax" placeholder="e.g. Antenatal check, Malaria test" />
          </div>
          <span class="counter num">{{ form.controls.reason.value.length }}/{{ reasonMax }}</span>
        </div>
        </div>

        <div class="vitals-col">
        <h2 class="field-label">Vitals</h2>
        <div class="card vitals" formGroupName="vitals">
          @for (f of vitalFields; track f.key) {
            <div class="field">
              <label class="input input-labelled vital" [class.invalid]="vitalInvalid(f.key)" [class.disabled]="deleted()">
                <span>{{ f.label }}</span>
                <span class="row">
                  <input [formControlName]="f.key" [attr.inputmode]="f.decimals ? 'decimal' : 'numeric'" autocomplete="off" />
                  <span class="suffix">{{ f.unit }}</span>
                </span>
              </label>
              @if (vitalInvalid(f.key)) { <span class="error-text">{{ vitalMessage(f) }}</span> }
            </div>
          }
        </div>
        </div>

        @if (!deleted()) {
          <div class="actions">
            <button type="submit" class="btn btn-filled" [disabled]="saving()">
              {{ id() ? 'Save changes' : 'Record visit' }}
            </button>
          </div>
        }
      </form>
    }

    <app-patient-picker #picker (picked)="pick($event)" />
    <app-confirm-dialog #confirmDelete title="Delete this visit?" action="Delete"
      message="It will be hidden on every device after the next sync. You can restore it from the patient’s page."
      (confirmed)="remove()" />
  `,
  styles: `
    .restore-text { margin: 4px 0 12px; }
    .patient { padding: 14px 16px; min-height: 76px; background: var(--surface); }
    .patient:hover:not(:disabled) { background: #fbfcfc; }
    .patient .placeholder { color: var(--muted); }
    .chev { color: var(--ink) !important; }
    .time input { border: 0; background: transparent; font-size: 16px; color: var(--ink); min-height: 40px; }
    .time input:focus { outline: none; }
    .time:focus-within { box-shadow: var(--focus); }
    .vitals { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px 12px; padding: 16px; }
    .vitals .field { min-width: 0; }
    .vital { min-height: 0; padding: 6px 12px; }
    .vital input { width: 100%; }
    .vital > span:first-child { font-size: 13px; color: var(--muted); }
    .vital input { padding: 2px 0 4px; }
    .vitals .error-text { padding: 0 4px; }
    @media (max-width: 360px) { .vitals { grid-template-columns: 1fr; } }
    .actions { margin-top: 24px; }

    /* Wide screens: patient full width at the top, visit details and Save on the left, vitals on the right. */
    @media (min-width: 1080px) {
      :host { --content-width: 1320px; }
      .screen {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        grid-template-areas: 'banner banner' 'patient patient' 'details vitals' 'actions vitals';
        grid-template-rows: auto auto auto 1fr;
        column-gap: 32px;
        align-items: start;
      }
      .panel-red { grid-area: banner; }
      .patient-col { grid-area: patient; }
      .details { grid-area: details; }
      .vitals-col { grid-area: vitals; }
      .actions { grid-area: actions; }
    }
  `,
})
export class VisitForm implements OnInit {
  /** Bound from the :id route param; absent when recording a new visit. */
  readonly id = input<string>();
  /** Optional ?patientId= query param to preselect the patient. */
  readonly patientId = input<string>();

  private readonly visits = inject(VisitService);
  private readonly patients = inject(PatientService);
  private readonly nav = inject(NavHistory);
  private readonly toast = inject(Toast);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly picker = viewChild.required<PatientPicker>('picker');

  protected readonly types = VISIT_TYPES;
  protected readonly vitalFields = VITAL_FIELDS;
  protected readonly reasonMax = REASON_MAX_LENGTH;
  protected readonly typeLabel = visitTypeLabel;
  protected readonly saving = signal(false);
  protected readonly notFound = signal(false);
  protected readonly deleted = signal(false);
  protected readonly patientName = signal<string | null>(null);
  protected readonly patientMissing = signal(false);
  private readonly chosenPatient = signal<string>('');
  protected readonly backTo = computed(() =>
    this.chosenPatient() ? `/patients/${this.chosenPatient()}` : '/visits',
  );

  protected readonly form = this.fb.group({
    visitType: ['outpatient' as VisitType, Validators.required],
    reason: ['', Validators.maxLength(REASON_MAX_LENGTH)],
    timestamp: [toDateTimeLocal(new Date().toISOString()), Validators.required],
    vitals: this.fb.group(
      Object.fromEntries(VITAL_FIELDS.map((f) => [f.key, ['', vitalValidator(f)]])) as Record<
        VitalKey,
        [string, ValidatorFn]
      >,
    ),
  });

  async ngOnInit(): Promise<void> {
    const id = this.id();
    if (!id) {
      const pid = this.patientId();
      // A merged patient's new visits belong to the patient it was merged into.
      if (pid) await this.setPatient(await this.patients.canonicalId(pid));
      return;
    }
    const visit = await this.visits.get(id);
    if (!visit) {
      this.notFound.set(true);
      return;
    }
    await this.setPatient(visit.patientId);
    this.setDeleted(!!visit.deletedAt);
    this.form.setValue({
      visitType: (VISIT_TYPES as readonly string[]).includes(visit.visitType)
        ? (visit.visitType as VisitType)
        : 'outpatient',
      reason: visit.reason,
      timestamp: toDateTimeLocal(visit.timestamp),
      vitals: Object.fromEntries(VITAL_FIELDS.map((f) => [f.key, visit[f.key]])) as Record<VitalKey, string>,
    });
  }

  protected pick(p: Patient): void {
    this.chosenPatient.set(p.id);
    this.patientName.set(p.name);
    this.patientMissing.set(false);
  }

  private async setPatient(id: string): Promise<void> {
    this.chosenPatient.set(id);
    this.patientName.set((await this.patients.get(id))?.name ?? 'Unknown patient');
  }

  private setDeleted(deleted: boolean): void {
    this.deleted.set(deleted);
    if (deleted) this.form.disable();
    else this.form.enable();
  }

  protected vitalInvalid(key: VitalKey): boolean {
    const c = this.form.controls.vitals.controls[key];
    return c.invalid && (c.touched || c.dirty);
  }

  protected vitalMessage(field: VitalField): string {
    return vitalError(field, this.form.controls.vitals.controls[field.key].value) ?? '';
  }

  protected async save(): Promise<void> {
    const patientId = this.chosenPatient();
    if (!patientId) {
      this.patientMissing.set(true);
      this.toast.show('Choose a patient.');
      return;
    }
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const { visitType, reason, timestamp, vitals } = this.form.getRawValue();
    const input: VisitInput = { ...EMPTY_VITALS, ...vitals, visitType, reason, timestamp: fromDateTimeLocal(timestamp) };
    await this.run(async () => {
      const id = this.id();
      if (id) await this.visits.update(id, input);
      else await this.visits.create(patientId, input);
      this.nav.back(`/patients/${patientId}`);
    });
  }

  protected async remove(): Promise<void> {
    const id = this.id();
    if (!id) return;
    await this.run(async () => {
      await this.visits.delete(id);
      this.nav.back(`/patients/${this.chosenPatient()}`);
    });
  }

  protected async restore(): Promise<void> {
    const id = this.id();
    if (!id) return;
    await this.run(async () => {
      await this.visits.restore(id);
      this.nav.back(`/patients/${this.chosenPatient()}`);
    });
  }

  private async run(task: () => Promise<void>): Promise<void> {
    this.saving.set(true);
    try {
      await task();
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.saving.set(false);
    }
  }

  protected readonly Trash2 = Trash2;
  protected readonly ChevronRight = ChevronRight;
  protected readonly Check = Check;
  protected readonly Clock = Clock;
  protected readonly NotebookPen = NotebookPen;
}
