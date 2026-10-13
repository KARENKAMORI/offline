import { Component, computed, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { History } from 'lucide-angular';
import { ActivityService } from '../../core/db/activity.service';
import type { SyncOutcome } from '../../core/db/models';
import { shortWhen } from '../../shared/format';
import { EmptyState } from '../../shared/ui/empty-state';
import { FieldBar } from '../../shared/ui/field-bar';
import { RecordCard } from '../../shared/ui/record-card';
import { SectionTitle } from '../../shared/ui/section-title';
import { Tag } from '../../shared/ui/tag';

const OUTCOMES: Record<SyncOutcome, { title: string; tag: string; tone: 'teal' | 'amber' | 'red' }> = {
  done: { title: 'Sync complete', tag: 'Done', tone: 'teal' },
  merged: { title: 'Sync with a merge', tag: 'Merged', tone: 'amber' },
  failed: { title: 'Sync failed', tag: 'Failed', tone: 'red' },
};

@Component({
  selector: 'app-sync-history',
  imports: [FieldBar, SectionTitle, RecordCard, Tag, EmptyState],
  template: `
    <app-field-bar title="Sync history" back="/sync" />
    <div class="screen">
      <div class="stats">
        <div class="card stat"><span class="num v" style="color: var(--ink)">{{ total() }}</span><span>Syncs</span></div>
        <div class="card stat"><span class="num v" style="color: var(--teal)">{{ counts().done }}</span><span>Done</span></div>
        <div class="card stat"><span class="num v" style="color: var(--amber-dot)">{{ counts().merged }}</span><span>Merged</span></div>
        <div class="card stat"><span class="num v" style="color: var(--red-strong)">{{ counts().failed }}</span><span>Failed</span></div>
      </div>
      <app-section-title text="Recent syncs" />
      <div class="list">
        @for (r of runs(); track r.id) {
          <app-record-card [title]="outcomes[r.outcome].title" [subtitle]="r.detail" [trailingTop]="when(r.finishedAt)">
            <app-tag trailing [tone]="outcomes[r.outcome].tone">{{ outcomes[r.outcome].tag }}</app-tag>
          </app-record-card>
        } @empty {
          <app-empty-state [icon]="History" message="No syncs yet." />
        }
      </div>
    </div>
  `,
  styles: `
    .stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; }
    .stat { display: flex; flex-direction: column; align-items: center; gap: 4px; padding: 18px 4px; min-width: 0; }
    .stat span:last-child { color: var(--muted); font-size: 15px; }
    .v { font-size: 32px; font-weight: 800; line-height: 1.1; }
    .list { display: flex; flex-direction: column; gap: 12px; }
  `,
})
export class SyncHistory {
  private readonly activity = inject(ActivityService);
  protected readonly runs = toSignal(this.activity.runs$, { initialValue: [] });
  protected readonly counts = toSignal(this.activity.runCounts$, { initialValue: { done: 0, merged: 0, failed: 0 } });
  protected readonly total = computed(() => this.counts().done + this.counts().merged + this.counts().failed);
  protected readonly outcomes = OUTCOMES;
  protected readonly when = shortWhen;
  protected readonly History = History;
}
