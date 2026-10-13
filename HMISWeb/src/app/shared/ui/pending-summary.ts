import { Component, computed, input } from '@angular/core';
import type { PendingChange } from '../../core/db/models';
import { ago, plural, shortWhen } from '../format';

/** Amber "N changes waiting to sync" card, or a calm one when there are none. */
@Component({
  selector: 'app-pending-summary',
  template: `
    <div class="panel" [class.panel-amber]="waiting()" [class.panel-teal]="!waiting()">
      <p class="headline">{{ headline() }}</p>
      <p class="sub">{{ sub() }}</p>
    </div>
  `,
  styles: `
    .panel { padding: 20px; }
    .headline { font-size: 20px; font-weight: 800; color: inherit; }
    .sub { margin-top: 6px; font-size: 16px; color: inherit; }
  `,
})
export class PendingSummary {
  readonly pending = input.required<PendingChange[]>();
  readonly lastSynced = input<string | null>(null);
  protected readonly waiting = computed(() => this.pending().length > 0);
  protected readonly headline = computed(() =>
    this.waiting() ? `${plural(this.pending().length, 'change')} waiting to sync` : 'Everything is synced',
  );
  protected readonly sub = computed(() => {
    if (this.waiting()) return `Oldest change made ${ago(this.pending()[0].time)}`;
    const last = this.lastSynced();
    return last ? `Last synced ${shortWhen(last).toLowerCase()}` : 'Not synced with the server yet';
  });
}
