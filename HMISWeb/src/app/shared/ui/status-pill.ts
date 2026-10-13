import { Component, inject } from '@angular/core';
import { SyncService } from '../../core/sync/sync.service';
import { PILL_LABELS, PillChip } from './pill-chip';
import { PillLegend } from './pill-legend';
import { Sheet } from './sheet';

/** Online / Offline / Syncing. Click for what each one means. */
@Component({
  selector: 'app-status-pill',
  imports: [Sheet, PillLegend, PillChip],
  template: `
    <button type="button" (click)="sheet.open()"
      [attr.aria-label]="labels[sync.connection()] + '. What does this mean?'">
      <app-pill-chip [state]="sync.connection()" />
    </button>
    <app-sheet #sheet>
      <app-pill-legend />
    </app-sheet>
  `,
  styles: `
    :host { display: inline-flex; }
    button { padding: 0; border: 0; background: none; border-radius: 20px; cursor: pointer; }
  `,
})
export class StatusPill {
  protected readonly sync = inject(SyncService);
  protected readonly labels = PILL_LABELS;
}
