import { Component, input } from '@angular/core';

/** Small rounded label, e.g. "Done", "Merged", "Head of household". */
@Component({
  selector: 'app-tag',
  template: `<ng-content />`,
  host: { '[attr.data-tone]': 'tone()' },
  styles: `
    :host { display: inline-block; padding: 4px 12px; border-radius: 14px; font-weight: 800; font-size: 14px;
      background: var(--teal-soft); color: var(--teal); white-space: nowrap; }
    :host([data-tone='amber']) { background: var(--amber-soft); color: var(--amber); }
    :host([data-tone='red']) { background: var(--red-soft); color: var(--red); }
  `,
})
export class Tag {
  readonly tone = input<'teal' | 'amber' | 'red'>('teal');
}
