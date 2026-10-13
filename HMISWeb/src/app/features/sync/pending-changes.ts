import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { LucideAngularModule, Minus, Pencil, Plus } from 'lucide-angular';
import { ActivityService } from '../../core/db/activity.service';
import type { ChangeVerb } from '../../core/db/models';
import { SyncService } from '../../core/sync/sync.service';
import { timeLabel } from '../../shared/format';
import { FieldBar } from '../../shared/ui/field-bar';
import { PendingSummary } from '../../shared/ui/pending-summary';
import { RecordCard } from '../../shared/ui/record-card';

const VERBS: Record<ChangeVerb, { title: string; tone: string; icon: typeof Plus }> = {
  added: { title: 'Added', tone: 'var(--teal)', icon: Plus },
  edited: { title: 'Edited', tone: 'var(--blue-dot)', icon: Pencil },
  deleted: { title: 'Deleted', tone: 'var(--red-strong)', icon: Minus },
};

@Component({
  selector: 'app-pending-changes',
  imports: [LucideAngularModule, FieldBar, PendingSummary, RecordCard],
  template: `
    <app-field-bar title="Pending changes" back="/sync" />
    <div class="screen">
      <app-pending-summary [pending]="pending()" [lastSynced]="sync.lastSyncedAt()" />
      <div class="list">
        @for (c of pending(); track $index) {
          <app-record-card [title]="verbs[c.verb].title" [subtitle]="c.summary" [trailingTop]="time(c.time)">
            <span leading class="verb" [style.background]="verbs[c.verb].tone">
              <lucide-icon [img]="verbs[c.verb].icon" [size]="22" />
            </span>
          </app-record-card>
        }
      </div>
      <p class="body-medium note">Changes are kept on this device, even if the browser is closed.</p>
      <button type="button" class="btn btn-filled" [disabled]="syncing()" (click)="sync.syncNow()">Sync now</button>
      <p class="body-medium center">Sync starts on its own when you're back online.</p>
    </div>
  `,
  styles: `
    .list { display: flex; flex-direction: column; gap: 12px; margin-top: 16px; }
    .verb { flex: none; display: inline-grid; place-items: center; width: 48px; height: 48px; border-radius: 50%; color: #fff; }
    .note { padding: 16px 4px; }
    .center { text-align: center; margin-top: 12px; }
  `,
})
export class PendingChanges {
  protected readonly sync = inject(SyncService);
  protected readonly pending = toSignal(inject(ActivityService).pendingChanges$, { initialValue: [] });
  protected readonly syncing = computed(() => this.sync.connection() === 'syncing');
  protected readonly verbs = VERBS;
  protected readonly time = timeLabel;
}
