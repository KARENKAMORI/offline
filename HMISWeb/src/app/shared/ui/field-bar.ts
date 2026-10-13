import { Component, inject, input } from '@angular/core';
import { ChevronLeft, LucideAngularModule } from 'lucide-angular';
import { NavHistory } from '../nav-history';
import { StatusPill } from './status-pill';

/** The design's header: a white bar with a title and the status pill (FieldAppBar). */
@Component({
  selector: 'app-field-bar',
  imports: [LucideAngularModule, StatusPill],
  template: `
    <div class="inner">
    @if (back()) {
      <button type="button" class="icon-btn btn back" aria-label="Back" (click)="nav.back(back()!)">
        <lucide-icon [img]="ChevronLeft" [size]="32" />
      </button>
    }
    <h1 [class.with-back]="!!back()">{{ title() }}</h1>
    <div class="actions"><ng-content /></div>
    <app-status-pill />
    </div>
  `,
  styles: `
    :host { position: sticky; top: 0; z-index: 10; display: block; background: var(--surface);
      border-bottom: 1px solid var(--divider); }
    .inner { display: flex; align-items: center; gap: 8px; height: var(--bar-height); padding: 0 16px 0 24px;
      max-width: var(--content-width); margin: 0 auto; }
    .inner:has(.back) { padding-left: 4px; }
    h1 { flex: 1; min-width: 0; font-size: 24px; font-weight: 800; white-space: nowrap; overflow: hidden;
      text-overflow: ellipsis; }
    .actions { display: flex; align-items: center; gap: 4px; }
    .actions:empty { display: none; }
    @media (max-width: 380px) { h1 { font-size: 20px; } }
  `,
})
export class FieldBar {
  readonly title = input.required<string>();
  /** Fallback route for the back button; no back button when unset. */
  readonly back = input<string | null>(null);
  protected readonly nav = inject(NavHistory);
  protected readonly ChevronLeft = ChevronLeft;
}
