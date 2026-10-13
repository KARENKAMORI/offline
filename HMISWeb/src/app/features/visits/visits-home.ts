import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { RouterLink } from '@angular/router';
import { LucideAngularModule, NotebookPen, TriangleAlert, X } from 'lucide-angular';
import { ActivityService, type NamedReplacedEdit } from '../../core/db/activity.service';
import { displayValue, fieldLabel } from '../../core/db/models';
import { PatientService } from '../../core/db/patient.service';
import { VisitService } from '../../core/db/visit.service';
import { ProfileService } from '../../core/profile.service';
import { SyncService } from '../../core/sync/sync.service';
import { dateTimeLabel, isSameDay, plural, timeLabel, weekdayLabel } from '../../shared/format';
import { EmptyState } from '../../shared/ui/empty-state';
import { FieldBar } from '../../shared/ui/field-bar';
import { SectionTitle } from '../../shared/ui/section-title';
import { Toast } from '../../shared/ui/toast';
import { VisitCard } from './visit-card';

/** Today at a glance: greeting, today's visits, and anything sync needs the user to know about. */
@Component({
  selector: 'app-visits-home',
  imports: [RouterLink, LucideAngularModule, FieldBar, SectionTitle, EmptyState, VisitCard],
  template: `
    <app-field-bar title="FieldVisit" />
    <div class="screen">
      <div class="layout">
        <div class="side">
          <div class="greeting">
            <h2 class="title-large">{{ greeting() }}</h2>
            <p class="body-medium">{{ subline() }}</p>
          </div>

          @if (sync.connection() === 'offline') {
            <div class="panel panel-teal block">
              <p class="panel-title">Loaded from this device</p>
              <p class="offline-sub">{{ lastSyncedLine() }}</p>
            </div>
          }

          <div class="panel panel-ink hero block">
            <p class="hero-count num">{{ countLine() }}</p>
            @if (waitingCount() > 0) {
              <p>{{ waitingCount() }} saved on this device, waiting to sync</p>
              <p>Keep working. Nothing is lost.</p>
            } @else if (today().length > 0) {
              <p>All saved to the server.</p>
            }
          </div>

          <div class="actions">
            <a class="btn btn-filled" routerLink="/visits/new">Record new visit</a>
            <a class="btn btn-text align-center" routerLink="/visits/all">See all visits</a>
          </div>
        </div>

        <div class="main">
          @for (n of notices(); track n.id) {
            <div class="panel panel-ink notice block">
              <div class="grow">
                <p class="panel-title">{{ n.title }}</p>
                <p>{{ n.body }}</p>
              </div>
              <button type="button" class="btn icon-btn on-dark" aria-label="Dismiss" (click)="activity.dismissNotice(n.id!)">
                <lucide-icon [img]="X" [size]="22" />
              </button>
            </div>
          }

          @for (e of replaced(); track e.patientId + e.path + e.key) {
            <div class="panel replaced block" role="alert">
              <p class="replaced-title">
                <lucide-icon [img]="TriangleAlert" [size]="22" />
                One of your edits was replaced
              </p>
              <p class="replaced-body">{{ replacedText(e) }}</p>
              <div class="two">
                <button type="button" class="btn btn-filled danger small" [disabled]="busy()" (click)="resolve(e, true)">
                  Re-enter mine
                </button>
                <button type="button" class="btn btn-outlined danger" [disabled]="busy()" (click)="resolve(e, false)">
                  Keep newer
                </button>
              </div>
            </div>
          }

          @if (next(); as v) {
            <section>
              <app-section-title text="Next visit" />
              <div class="cards">
                <app-visit-card [visit]="v" [patientName]="names().get(v.patientId)" [waiting]="pending().has(v.patientId)" />
              </div>
            </section>
          }

          <section>
            <app-section-title text="Today's visits"><span class="num">{{ today().length }} total</span></app-section-title>
            <div class="cards">
              @for (v of today(); track v.id) {
                <app-visit-card [visit]="v" [patientName]="names().get(v.patientId)" [waiting]="pending().has(v.patientId)" />
              } @empty {
                <app-empty-state [icon]="NotebookPen" message="No visits recorded today." />
              }
            </div>
          </section>
        </div>
      </div>
    </div>
  `,
  styles: `
    /* Phones: one column in the mobile app's order; the actions move to the end. */
    .layout { display: flex; flex-direction: column; }
    .side, .main { display: contents; }
    .actions { order: 1; display: flex; flex-direction: column; gap: 8px; margin-top: 20px; }
    .block { margin-top: 12px; }
    .greeting + .block { margin-top: 0; }

    .greeting { padding: 16px 4px 20px; }
    .greeting h2 { font-size: 22px; }
    .greeting p { margin-top: 4px; font-size: 16px; }
    .offline-sub { margin-top: 4px; font-size: 15px; }
    .hero { padding: 22px 24px; border-radius: var(--radius-hero); }
    .hero .hero-count { font-size: 28px; font-weight: 800; color: #fff !important; margin-bottom: 8px; }
    .hero p { font-size: 16px; line-height: 1.5; }
    .notice { display: flex; align-items: flex-start; gap: 8px; padding: 16px 8px 18px 20px; }
    .notice .grow { flex: 1; }
    .notice .panel-title { color: #fff; margin-bottom: 6px; }
    .on-dark { color: #fff; }
    .on-dark:hover { background: rgb(255 255 255 / 0.12) !important; }
    .replaced { background: var(--red-soft); border: 1px solid var(--red-strong); padding: 20px; }
    .replaced-title { display: flex; align-items: center; gap: 8px; color: var(--red) !important; font-weight: 800;
      font-size: 18px; }
    .replaced-body { margin: 10px 0 16px; font-size: 16px; line-height: 1.45; }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .small { min-height: 52px; font-size: 16px; }
    .cards { display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
    .cards app-empty-state { grid-column: 1 / -1; }

    /* Wide screens: summary and actions on the left, visits fill the rest as a card grid. */
    @media (min-width: 1080px) {
      :host { --content-width: 1320px; }
      .layout { display: grid; grid-template-columns: 360px minmax(0, 1fr); gap: 0 32px; align-items: start; }
      .side, .main { display: block; }
      .side { position: sticky; top: calc(var(--bar-height) + 16px); }
      .actions { margin-top: 16px; }
      .main > .block:first-child { margin-top: 16px; }
      .cards { grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); }
    }
  `,
})
export class VisitsHome {
  protected readonly sync = inject(SyncService);
  protected readonly activity = inject(ActivityService);
  private readonly profile = inject(ProfileService).profile;
  private readonly toast = inject(Toast);

  private readonly visits = toSignal(inject(VisitService).visits$, { initialValue: [] });
  // Merged duplicates included: a visit may still be stored under one.
  private readonly patients = toSignal(inject(PatientService).allPatients$, { initialValue: [] });
  protected readonly pending = toSignal(this.sync.pendingIds$, { initialValue: new Set<string>() });
  protected readonly notices = toSignal(this.activity.notices$, { initialValue: [] });
  protected readonly replaced = toSignal(this.activity.replaced$, { initialValue: [] });
  protected readonly busy = signal(false);

  protected readonly names = computed(() => new Map(this.patients().map((p) => [p.id, p.name])));
  /** Today's visits in time order, as the phone lists them. */
  protected readonly today = computed(() =>
    this.visits()
      .filter((v) => isSameDay(v.timestamp))
      .sort((a, b) => a.timestamp.localeCompare(b.timestamp)),
  );
  protected readonly next = computed(() => {
    const now = Date.now();
    return this.today().find((v) => new Date(v.timestamp).getTime() > now);
  });
  protected readonly waitingCount = computed(
    () => this.today().filter((v) => this.pending().has(v.patientId)).length,
  );
  protected readonly countLine = computed(() => `${plural(this.today().length, 'visit')} today`);

  protected readonly greeting = computed(() => {
    const hour = new Date().getHours();
    const part = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
    const name = this.profile().workerName;
    return name ? `Good ${part}, ${name}` : `Good ${part}`;
  });
  protected readonly subline = computed(() => {
    const area = this.profile().area;
    return area ? `${area}, ${weekdayLabel()}` : weekdayLabel();
  });
  protected readonly lastSyncedLine = computed(() => {
    const last = this.sync.lastSyncedAt();
    if (!last) return 'Not synced with the server yet';
    return `Last synced with the server ${isSameDay(last) ? 'at ' + timeLabel(last) : 'on ' + dateTimeLabel(last)}`;
  });

  protected replacedText(e: NamedReplacedEdit): string {
    return (
      `You changed ${e.patientName}'s ${fieldLabel(e.key)} to ${displayValue(e.key, e.mine)}. ` +
      `An edit from ${e.keptBy} at the same time set it to ${displayValue(e.key, e.kept)}, ` +
      'so that value was kept.'
    );
  }

  protected async resolve(e: NamedReplacedEdit, keepMine: boolean): Promise<void> {
    this.busy.set(true);
    try {
      await this.activity.resolve(e, keepMine);
    } catch (err) {
      this.toast.error(err);
    } finally {
      this.busy.set(false);
    }
  }

  protected readonly NotebookPen = NotebookPen;
  protected readonly TriangleAlert = TriangleAlert;
  protected readonly X = X;
}
