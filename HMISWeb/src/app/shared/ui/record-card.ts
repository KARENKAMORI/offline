import { Component, input, output } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { RouterLink } from '@angular/router';

/**
 * A white card row: leading, title over subtitle, and a trailing column (RecordCard in widgets.dart).
 * Project the leading widget with [leading] and the bottom-right widget with [trailing].
 */
@Component({
  selector: 'app-record-card',
  imports: [RouterLink, NgTemplateOutlet],
  template: `
    <ng-template #body>
      <ng-content select="[leading]" />
      <span class="text">
        <span class="title">{{ title() }}</span>
        @if (subtitle()) {
          <span class="subtitle">{{ subtitle() }}</span>
        }
      </span>
      <span class="trailing">
        @if (trailingTop()) {
          <span class="top num">{{ trailingTop() }}</span>
        }
        <ng-content select="[trailing]" />
      </span>
    </ng-template>

    @if (link()) {
      <a class="card row" [routerLink]="link()" [queryParams]="queryParams()">
        <ng-container [ngTemplateOutlet]="body" />
      </a>
    } @else if (button()) {
      <button type="button" class="card row" (click)="pressed.emit()">
        <ng-container [ngTemplateOutlet]="body" />
      </button>
    } @else {
      <div class="card row"><ng-container [ngTemplateOutlet]="body" /></div>
    }
  `,
  styles: `
    :host { display: block; height: 100%; }
    .row { display: flex; align-items: center; gap: 14px; width: 100%; height: 100%; padding: 16px; border: 0;
      text-align: left; color: inherit; text-decoration: none; font: inherit; }
    a.row, button.row { cursor: pointer; transition: background-color 120ms ease; }
    a.row:hover, button.row:hover { background: #fbfcfc; }
    .text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
    .title { font-size: 17px; font-weight: 800; color: var(--ink); overflow: hidden; text-overflow: ellipsis;
      white-space: nowrap; }
    .subtitle { font-size: 15px; color: var(--muted); display: -webkit-box; -webkit-line-clamp: 2;
      -webkit-box-orient: vertical; overflow: hidden; }
    .trailing { display: flex; flex-direction: column; align-items: flex-end; gap: 8px; flex: none; }
    .trailing:empty { display: none; }
    .top { font-size: 16px; color: var(--muted); white-space: nowrap; }
  `,
})
export class RecordCard {
  readonly title = input.required<string>();
  readonly subtitle = input<string>('');
  readonly trailingTop = input<string>('');
  readonly link = input<string | unknown[] | null>(null);
  readonly queryParams = input<Record<string, string> | null>(null);
  /** Render as a button and emit pressed instead of navigating. */
  readonly button = input(false);
  readonly pressed = output<void>();
}
