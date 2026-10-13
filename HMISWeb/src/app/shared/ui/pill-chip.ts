import { Component, input } from '@angular/core';
import type { Connection } from '../../core/sync/sync.service';

export const PILL_LABELS: Record<Connection, string> = {
  online: 'Online',
  offline: 'Offline',
  syncing: 'Syncing',
};

/** The pill's look, without behaviour. */
@Component({
  selector: 'app-pill-chip',
  template: `<span class="dot" aria-hidden="true"></span>{{ labels[state()] }}`,
  host: { '[attr.data-c]': 'state()' },
  styles: `
    :host { display: inline-flex; align-items: center; gap: 8px; padding: 7px 14px; border-radius: 20px;
      font-weight: 800; font-size: 15px; background: var(--teal-soft); color: var(--ink); white-space: nowrap; }
    .dot { width: 12px; height: 12px; border-radius: 50%; background: var(--teal); }
    :host([data-c='offline']) { background: var(--amber-soft); color: var(--amber); }
    :host([data-c='offline']) .dot { background: var(--amber-dot); }
    :host([data-c='syncing']) { background: var(--blue-soft); color: var(--blue); }
    :host([data-c='syncing']) .dot { background: var(--blue-dot); }
  `,
})
export class PillChip {
  readonly state = input.required<Connection>();
  protected readonly labels = PILL_LABELS;
}
