import { Component, computed, inject } from '@angular/core';
import { SyncService } from '../../core/sync/sync.service';
import { plural } from '../format';
import { SectionTitle } from './section-title';
import { PillChip } from './pill-chip';

/** "What the status pill means", with live progress while syncing. */
@Component({
  selector: 'app-pill-legend',
  imports: [PillChip, SectionTitle],
  template: `
    <app-section-title text="What the status pill means" />
    <div class="stack-12">
      <div class="card legend">
        <app-pill-chip state="online" />
        <p>Connected. Changes sync to the server on their own</p>
      </div>
      <div class="card legend">
        <app-pill-chip state="offline" />
        <p>No connection. Changes are saved on this device and sync when you're back online</p>
      </div>
      <div class="card legend">
        <app-pill-chip state="syncing" />
        <div class="row">
          <p>{{ syncingText() }}</p>
          @if (showProgress()) {
            <span class="count num">{{ sync.progressDone() }} of {{ sync.progressTotal() }}</span>
          }
        </div>
        @if (showProgress()) {
          <progress [value]="sync.progressDone()" [max]="sync.progressTotal()"></progress>
        }
      </div>
    </div>
  `,
  styles: `
    :host { display: block; }
    .legend { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; padding: 18px; }
    .legend p { color: var(--muted); font-size: 16px; flex: 1; }
    .row { display: flex; align-items: center; gap: 12px; width: 100%; }
    .count { color: var(--blue); font-weight: 800; }
    progress { width: 100%; height: 6px; appearance: none; border: 0; border-radius: 4px; overflow: hidden;
      background: var(--blue-soft); }
    progress::-webkit-progress-bar { background: var(--blue-soft); }
    progress::-webkit-progress-value { background: var(--blue-dot); }
    progress::-moz-progress-bar { background: var(--blue-dot); }
  `,
})
export class PillLegend {
  protected readonly sync = inject(SyncService);
  protected readonly showProgress = computed(
    () => this.sync.connection() === 'syncing' && this.sync.progressTotal() > 0,
  );
  protected readonly syncingText = computed(() =>
    this.sync.connection() === 'syncing' && this.sync.sending() > 0
      ? `Sending ${plural(this.sync.sending(), 'change')} to the server`
      : 'Sending changes to the server',
  );
}
