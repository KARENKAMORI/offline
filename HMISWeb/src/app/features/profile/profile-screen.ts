import { Component, effect, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, type AbstractControl } from '@angular/forms';
import { IdCard, LucideAngularModule, Map as MapIcon, Monitor, Server } from 'lucide-angular';
import { ProfileService } from '../../core/profile.service';
import { SyncService } from '../../core/sync/sync.service';
import { FieldBar } from '../../shared/ui/field-bar';
import { PillLegend } from '../../shared/ui/pill-legend';
import { Toast } from '../../shared/ui/toast';

function serverUrl(c: AbstractControl): { url: true } | null {
  const v = String(c.value ?? '').trim();
  if (!v) return null;
  try {
    const u = new URL(v);
    return /^https?:$/.test(u.protocol) && u.host ? null : { url: true };
  } catch {
    return { url: true };
  }
}

/** Who uses this browser, its name on other devices, and the server address (profile_screen.dart). */
@Component({
  selector: 'app-profile-screen',
  imports: [ReactiveFormsModule, LucideAngularModule, FieldBar, PillLegend],
  template: `
    <app-field-bar title="Profile" />
    <form class="screen" [formGroup]="form" (ngSubmit)="save()" novalidate>
      <div class="fields">
        <label class="input input-labelled">
          <span class="row"><lucide-icon [img]="IdCard" [size]="22" />
            <span class="grow"><span class="float">Your name</span>
              <input formControlName="workerName" placeholder="e.g. Nurse Wairimu" autocomplete="name" /></span>
          </span>
        </label>
        <label class="input input-labelled">
          <span class="row"><lucide-icon [img]="MapIcon" [size]="22" />
            <span class="grow"><span class="float">Area</span>
              <input formControlName="area" placeholder="e.g. Kinangop sub-county" /></span>
          </span>
        </label>
        <div class="field">
          <label class="input input-labelled">
            <span class="row"><lucide-icon [img]="Monitor" [size]="22" />
              <span class="grow"><span class="float">Device name</span>
                <input formControlName="deviceName" /></span>
            </span>
          </label>
          <span class="hint">Shown on other devices when your edits meet theirs.</span>
        </div>
        <div class="field">
          <label class="input input-labelled" [class.invalid]="form.controls.serverUrl.invalid && form.controls.serverUrl.touched">
            <span class="row"><lucide-icon [img]="Server" [size]="22" />
              <span class="grow"><span class="float">Server address</span>
                <input formControlName="serverUrl" type="url" inputmode="url" placeholder="Same as this site" /></span>
            </span>
          </label>
          @if (form.controls.serverUrl.invalid && form.controls.serverUrl.touched) {
            <span class="error-text">Enter an address like http://192.168.1.10:8000</span>
          } @else {
            <span class="hint">Leave blank to use the server this app was loaded from.</span>
          }
        </div>
      </div>
      <div class="gap-24"></div>
      <button type="submit" class="btn btn-filled" [disabled]="saving()">Save</button>
      <p class="device num">Device ID {{ profile.deviceId() }}</p>
      <app-pill-legend />
    </form>
  `,
  styles: `
    .fields { display: flex; flex-direction: column; gap: 16px; padding-top: 4px; }
    .grow { flex: 1; display: flex; flex-direction: column; }
    .float { font-size: 13px; color: var(--muted); }
    .input-labelled input { padding: 2px 0 4px; }
    .input-labelled .row { gap: 12px; }
    .device { margin-top: 16px; text-align: center; color: var(--muted); font-size: 12px; }

    /* Wide screens: the form on the left, what the status pill means on the right. */
    @media (min-width: 1080px) {
      :host { --content-width: 1320px; }
      .screen {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        grid-template-rows: auto auto auto 1fr;
        column-gap: 32px;
        align-items: start;
      }
      .screen > :not(app-pill-legend) { grid-column: 1; }
      app-pill-legend { grid-column: 2; grid-row: 1 / -1; margin-top: -16px; }
    }
  `,
})
export class ProfileScreen {
  protected readonly profile = inject(ProfileService);
  private readonly sync = inject(SyncService);
  private readonly toast = inject(Toast);
  protected readonly saving = signal(false);

  protected readonly form = inject(NonNullableFormBuilder).group({
    workerName: [''],
    area: [''],
    deviceName: [''],
    serverUrl: ['', serverUrl],
  });

  constructor() {
    // Fill the form once the stored profile has loaded, unless the user already started typing.
    effect(() => {
      const p = this.profile.profile();
      if (!this.form.dirty) this.form.setValue(p, { emitEvent: false });
    });
  }

  protected async save(): Promise<void> {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    this.saving.set(true);
    try {
      await this.profile.save(this.form.getRawValue());
      this.form.markAsPristine();
      this.toast.show('Profile saved');
      void this.sync.syncNow();
    } catch (e) {
      this.toast.error(e);
    } finally {
      this.saving.set(false);
    }
  }

  protected readonly IdCard = IdCard;
  protected readonly MapIcon = MapIcon;
  protected readonly Monitor = Monitor;
  protected readonly Server = Server;
}
