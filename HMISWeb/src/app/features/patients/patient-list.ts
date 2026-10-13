import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, Search, UserPlus, Users } from 'lucide-angular';
import { statusLabel, type Patient } from '../../core/db/models';
import { PatientService } from '../../core/db/patient.service';
import { SyncService } from '../../core/sync/sync.service';
import { Avatar } from '../../shared/ui/avatar';
import { EmptyState } from '../../shared/ui/empty-state';
import { FieldBar } from '../../shared/ui/field-bar';
import { RecordCard } from '../../shared/ui/record-card';
import { SyncBadge } from '../../shared/ui/sync-badge';

/** "Head of household · Suspended · Kibera · 0712345678", as on the phone. */
export function patientSubtitle(p: Patient): string {
  return [
    p.headOfHousehold ? 'Head of household' : '',
    p.status !== 'active' ? statusLabel(p.status) : '',
    p.location,
    p.phone,
  ]
    .filter(Boolean)
    .join(' · ');
}

export function matchesSearch(p: Patient, query: string): boolean {
  const q = query.trim().toLowerCase();
  return !q || [p.name, p.phone, p.location].some((v) => v.toLowerCase().includes(q));
}

@Component({
  selector: 'app-patient-list',
  imports: [RouterLink, NgTemplateOutlet, LucideAngularModule, FieldBar, RecordCard, Avatar, SyncBadge, EmptyState],
  template: `
    <ng-template #search>
      <lucide-icon [img]="Search" [size]="22" />
      <span class="sr-only">Search patients</span>
      <input type="search" placeholder="Search name, phone or location"
        [value]="query()" (input)="query.set($any($event.target).value)" />
    </ng-template>

    <app-field-bar title="Patients">
      <label class="input bar-search"><ng-container [ngTemplateOutlet]="search" /></label>
    </app-field-bar>
    <div class="screen">
      <label class="input page-search"><ng-container [ngTemplateOutlet]="search" /></label>

      <div class="list">
        @for (p of filtered(); track p.id) {
          <app-record-card [title]="p.name" [subtitle]="subtitle(p)" [link]="['/patients', p.id]">
            <app-avatar leading [name]="p.name" />
            <app-sync-badge trailing [waiting]="pending().has(p.id)" />
          </app-record-card>
        } @empty {
          @if (patients() !== undefined) {
            <app-empty-state [icon]="Users" [message]="query()
              ? 'No patients match your search.'
              : 'No patients on this device yet.\nRegister one, or sync to download.'" />
          }
        }
      </div>
    </div>

    <a class="fab" routerLink="/patients/new">
      <lucide-icon [img]="UserPlus" [size]="22" />
      Register patient
    </a>
  `,
  styles: `
    /* Phones: search on its own row, as in the mobile app. Wide screens: in the header, right of the title. */
    .bar-search { display: none; }
    @media (min-width: 900px) {
      .bar-search { display: flex; width: min(420px, 40vw); min-height: 44px; margin-right: 8px; }
      .bar-search input { padding: 10px 0; }
      .page-search { display: none; }
    }
    .list { display: flex; flex-direction: column; gap: 12px; padding: 16px 0 96px; }
    .fab { position: fixed; right: 16px; bottom: calc(var(--tabs-height) + 16px); z-index: 12;
      display: inline-flex; align-items: center; gap: 10px; height: 56px; padding: 0 20px; border-radius: 16px;
      background: var(--teal-soft); color: var(--teal); font-weight: 800; text-decoration: none;
      box-shadow: 0 3px 6px rgb(0 0 0 / 0.16), 0 3px 6px rgb(0 0 0 / 0.1); }
    .fab:hover { background: #cfe6df; }
    @media (min-width: 900px) { .fab { bottom: 24px; right: 24px; } }
  `,
})
export class PatientList {
  protected readonly patients = toSignal(inject(PatientService).patients$);
  protected readonly pending = toSignal(inject(SyncService).pendingIds$, { initialValue: new Set<string>() });
  protected readonly query = signal('');
  protected readonly filtered = computed(() =>
    (this.patients() ?? []).filter((p) => matchesSearch(p, this.query())),
  );
  protected readonly subtitle = patientSubtitle;
  protected readonly Search = Search;
  protected readonly UserPlus = UserPlus;
  protected readonly Users = Users;
}
