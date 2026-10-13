import { Component, computed, effect, inject, input, signal } from '@angular/core';
import { toObservable, toSignal } from '@angular/core/rxjs-interop';
import { Router, RouterLink } from '@angular/router';
import { map, switchMap } from 'rxjs';
import { Calendar, LucideAngularModule, MapPin, NotebookPen, Pencil, Phone, UserX } from 'lucide-angular';
import { statusLabel, visitTitle, visitTypeLabel, type Visit } from '../../core/db/models';
import { PatientService } from '../../core/db/patient.service';
import { VisitService } from '../../core/db/visit.service';
import { SyncService } from '../../core/sync/sync.service';
import { dateTimeLabel, shortWhen } from '../../shared/format';
import { vitalsSummary } from '../../shared/vitals.pipe';
import { Avatar } from '../../shared/ui/avatar';
import { EmptyState } from '../../shared/ui/empty-state';
import { FieldBar } from '../../shared/ui/field-bar';
import { RecordCard } from '../../shared/ui/record-card';
import { SectionTitle } from '../../shared/ui/section-title';
import { SyncBadge } from '../../shared/ui/sync-badge';
import { Tag } from '../../shared/ui/tag';

@Component({
  selector: 'app-patient-detail',
  imports: [RouterLink, LucideAngularModule, FieldBar, Avatar, Tag, SyncBadge, RecordCard, SectionTitle, EmptyState],
  template: `
    <app-field-bar title="Patient" back="/patients">
      @if (patient()) {
        <a class="btn icon-btn" routerLink="edit" aria-label="Edit patient" title="Edit patient">
          <lucide-icon [img]="Pencil" [size]="22" />
        </a>
      }
    </app-field-bar>

    @if (patient(); as p) {
      <div class="screen">
        <div class="header">
          <app-avatar [name]="p.name" />
          <div class="who">
            <h2 class="title-large">{{ p.name }}</h2>
            <div class="tags">
              @if (p.headOfHousehold) { <app-tag>Head of household</app-tag> }
              @if (p.status === 'active') { <app-tag>Active</app-tag> }
              @else { <app-tag tone="amber">{{ label(p.status) }}</app-tag> }
            </div>
          </div>
          <app-sync-badge [waiting]="waiting()" />
        </div>

        @if (merged()) {
          <div class="panel panel-teal gap" role="status">
            <p class="panel-title">Merged with an existing record for this patient.</p>
            @if (p.mergedInto) {
              <p class="muted">That record has not downloaded yet. It opens here after the next sync.</p>
            }
          </div>
        }

        @if (problems().length) {
          <div class="panel panel-red gap">
            <p class="panel-title">The server could not save some values</p>
            <ul>
              @for (m of problems(); track m) { <li>{{ m }}</li> }
            </ul>
            <p class="muted">Correct them here and they will sync again.</p>
          </div>
        }

        <div class="card gap">
          <div class="tile">
            <lucide-icon [img]="Phone" [size]="24" />
            <div class="text"><div class="body-medium">Phone</div><div class="body-large num">{{ p.phone || '—' }}</div></div>
          </div>
          <div class="tile">
            <lucide-icon [img]="MapPin" [size]="24" />
            <div class="text"><div class="body-medium">Location</div><div class="body-large">{{ p.location || '—' }}</div></div>
          </div>
          <div class="tile">
            <lucide-icon [img]="Calendar" [size]="24" />
            <div class="text"><div class="body-medium">Registered</div><div class="body-large">{{ registered(p.registeredAt) }}</div></div>
          </div>
        </div>

        <app-section-title text="Visits"><span class="num">{{ active().length }} total</span></app-section-title>
        <div class="list">
          @for (v of active(); track v.id) {
            <app-record-card [title]="title(v)" [subtitle]="visitSubtitle(v)" [trailingTop]="when(v.timestamp)"
              [link]="['/visits', v.id]">
              <app-sync-badge trailing [waiting]="waiting()" />
            </app-record-card>
          } @empty {
            <app-empty-state [icon]="NotebookPen" message="No visits recorded." />
          }
        </div>

        @if (deleted().length) {
          <button type="button" class="btn btn-text align-center" (click)="showDeleted.set(!showDeleted())">
            {{ showDeleted() ? 'Hide deleted visits' : 'Show ' + deleted().length + ' deleted ' + (deleted().length === 1 ? 'visit' : 'visits') }}
          </button>
          @if (showDeleted()) {
            <div class="list">
              @for (v of deleted(); track v.id) {
                <app-record-card [title]="title(v)" [subtitle]="visitSubtitle(v)" [trailingTop]="when(v.timestamp)"
                  [link]="['/visits', v.id]">
                  <app-tag trailing tone="red">Deleted</app-tag>
                </app-record-card>
              }
            </div>
          }
        }

        <div class="gap-8"></div>
        <a class="btn btn-filled" routerLink="/visits/new" [queryParams]="{ patientId: p.id }">Record new visit</a>
      </div>
    } @else if (loaded()) {
      <app-empty-state [icon]="UserX" message="This patient has not finished downloading." />
    }
  `,
  styles: `
    .header { display: flex; align-items: center; gap: 14px; }
    .who { flex: 1; min-width: 0; }
    .tags { display: flex; flex-wrap: wrap; gap: 8px 8px; margin-top: 6px; }
    .gap { margin-top: 12px; }
    .panel ul { margin: 6px 0; padding-left: 20px; }
    .muted { color: var(--muted) !important; }
    .list { display: flex; flex-direction: column; gap: 12px; }
    .list + .btn-text { margin-top: 8px; }
    .list:has(+ .gap-8) { margin-bottom: 12px; }
  `,
})
export class PatientDetail {
  readonly id = input.required<string>();

  private readonly patients = inject(PatientService);
  private readonly visits = inject(VisitService);
  private readonly sync = inject(SyncService);
  private readonly router = inject(Router);
  private readonly id$ = toObservable(this.id);

  private readonly state = toSignal(this.id$.pipe(switchMap((id) => this.patients.watch(id))), {
    initialValue: null,
  });
  protected readonly patient = computed(() => this.state() ?? undefined);
  protected readonly loaded = computed(() => this.state() !== null);

  /** The patient this page was redirected to from a merged duplicate. */
  private readonly redirectedTo = signal('');
  protected readonly merged = computed(
    () => !!this.patient()?.mergedInto || this.redirectedTo() === this.id(),
  );

  private readonly allVisits = toSignal(this.id$.pipe(switchMap((id) => this.visits.forPatientAll$(id))), {
    initialValue: [] as Visit[],
  });
  protected readonly active = computed(() => this.allVisits().filter((v) => !v.deletedAt));
  protected readonly deleted = computed(() => this.allVisits().filter((v) => v.deletedAt));
  protected readonly showDeleted = signal(false);

  protected readonly problems = toSignal(this.id$.pipe(switchMap((id) => this.sync.problemsFor$(id))), {
    initialValue: [],
  });
  protected readonly waiting = toSignal(
    this.id$.pipe(switchMap((id) => this.sync.pendingIds$.pipe(map((ids) => ids.has(id))))),
    { initialValue: false },
  );

  constructor() {
    effect(() => {
      const p = this.patient();
      if (p?.mergedInto) void this.openCanonical(p.id);
    });
  }

  /** A merged duplicate opens the patient it was merged into, if that one is on this device. */
  private async openCanonical(id: string): Promise<void> {
    const target = await this.patients.canonicalId(id);
    if (target === id || this.id() !== id) return;
    this.redirectedTo.set(target);
    await this.router.navigate(['/patients', target], { replaceUrl: true });
  }

  protected readonly label = statusLabel;
  protected readonly title = visitTitle;
  protected readonly when = shortWhen;
  protected registered(iso: string): string {
    return dateTimeLabel(iso) || '—';
  }
  protected visitSubtitle(v: Visit): string {
    return [v.reason ? visitTypeLabel(v.visitType) : '', vitalsSummary(v)].filter(Boolean).join(' · ');
  }

  protected readonly Pencil = Pencil;
  protected readonly Phone = Phone;
  protected readonly MapPin = MapPin;
  protected readonly Calendar = Calendar;
  protected readonly NotebookPen = NotebookPen;
  protected readonly UserX = UserX;
}
