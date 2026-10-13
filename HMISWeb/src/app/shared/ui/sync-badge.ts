import { Component, input } from '@angular/core';
import { Check, Clock, LucideAngularModule } from 'lucide-angular';

/** "✓ Synced" or "◷ Waiting". */
@Component({
  selector: 'app-sync-badge',
  imports: [LucideAngularModule],
  template: `
    <lucide-icon [img]="waiting() ? Clock : Check" [size]="16" [strokeWidth]="2.5" aria-hidden="true" />
    {{ waiting() ? 'Waiting' : 'Synced' }}
  `,
  host: { '[class.waiting]': 'waiting()' },
  styles: `
    :host { display: inline-flex; align-items: center; gap: 6px; color: var(--teal); font-weight: 800;
      font-size: 15px; white-space: nowrap; }
    :host(.waiting) { color: var(--amber-dot); }
  `,
})
export class SyncBadge {
  readonly waiting = input.required<boolean>();
  protected readonly Check = Check;
  protected readonly Clock = Clock;
}
