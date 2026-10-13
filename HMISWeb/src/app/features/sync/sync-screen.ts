import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ChevronRight, History, ListTodo, LucideAngularModule } from 'lucide-angular';
import { ActivityService } from '../../core/db/activity.service';
import { SyncService } from '../../core/sync/sync.service';
import { plural } from '../../shared/format';
import { FieldBar } from '../../shared/ui/field-bar';
import { PendingSummary } from '../../shared/ui/pending-summary';
import { PillLegend } from '../../shared/ui/pill-legend';
import { RecordCard } from '../../shared/ui/record-card';

@Component({
  selector: 'app-sync-screen',
  imports: [LucideAngularModule, FieldBar, PendingSummary, RecordCard, PillLegend],
  template: `
    <app-field-bar title="Sync" />
    <div class="screen">
      <div class="main-col">
      <app-pending-summary [pending]="pending()" [lastSynced]="sync.lastSyncedAt()" />
      @if (sync.lastError()) {
        <p class="error" role="alert">{{ sync.lastError() }}</p>
      }
      <div class="gap-16"></div>
      <button type="button" class="btn btn-filled" [disabled]="syncing()" (click)="sync.syncNow()">
        {{ syncing() ? 'Syncing…' : 'Sync now' }}
      </button>
      <p class="body-medium center">Sync starts on its own when you're back online.</p>

      @if (problems() > 0) {
        <div class="panel panel-red problems">
          {{ problems() === 1 ? '1 patient has' : problems() + ' patients have' }} values the server could not
          save. Open the patient to see what to correct.
        </div>
      }

      <div class="links">
        <app-record-card title="Pending changes" [subtitle]="pendingLine()" link="/sync/pending">
          <lucide-icon leading [img]="ListTodo" [size]="28" class="lead" />
          <lucide-icon trailing [img]="ChevronRight" [size]="24" />
        </app-record-card>
        <app-record-card title="Sync history" [subtitle]="historyLine()" link="/sync/history">
          <lucide-icon leading [img]="History" [size]="28" class="lead" />
          <lucide-icon trailing [img]="ChevronRight" [size]="24" />
        </app-record-card>
      </div>
      </div>

      <app-pill-legend />
    </div>
  `,
  styles: `
    .error { margin-top: 12px; color: var(--red); font-weight: 700; }
    .center { text-align: center; margin-top: 8px; }
    .problems { margin-top: 16px; font-weight: 700; padding: 16px; }
    .links { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
    .lead { color: var(--teal); flex: none; }

    /* Wide screens: sync status and actions on the left, what the status pill means on the right. */
    @media (min-width: 1080px) {
      :host { --content-width: 1320px; }
      .screen {
        display: grid;
        grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
        column-gap: 32px;
        align-items: start;
      }
      app-pill-legend { margin-top: -20px; }
    }
  `,
})
export class SyncScreen {
  protected readonly sync = inject(SyncService);
  private readonly activity = inject(ActivityService);
  protected readonly pending = toSignal(this.activity.pendingChanges$, { initialValue: [] });
  protected readonly problems = toSignal(this.activity.problemCount$, { initialValue: 0 });
  private readonly counts = toSignal(this.activity.runCounts$, { initialValue: { done: 0, merged: 0, failed: 0 } });

  protected readonly syncing = computed(() => this.sync.connection() === 'syncing');
  protected readonly pendingLine = computed(() =>
    this.pending().length ? `${this.pending().length} saved on this device` : 'Nothing waiting',
  );
  protected readonly historyLine = computed(() => {
    const c = this.counts();
    const total = c.done + c.merged + c.failed;
    return total ? `${plural(total, 'sync')} · ${c.failed} failed` : 'No syncs yet';
  });

  protected readonly ListTodo = ListTodo;
  protected readonly History = History;
  protected readonly ChevronRight = ChevronRight;
}
