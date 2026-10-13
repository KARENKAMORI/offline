import { Component, input } from '@angular/core';
import { LucideAngularModule, type LucideIconData } from 'lucide-angular';

@Component({
  selector: 'app-empty-state',
  imports: [LucideAngularModule],
  template: `
    <lucide-icon [img]="icon()" [size]="48" aria-hidden="true" />
    <p>{{ message() }}</p>
  `,
  styles: `
    :host { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 40px 24px; text-align: center; }
    lucide-icon { color: var(--nav-idle); }
    p { color: var(--muted); font-size: 15px; white-space: pre-line; }
  `,
})
export class EmptyState {
  readonly icon = input.required<LucideIconData>();
  readonly message = input.required<string>();
}
