import { Component, input } from '@angular/core';

@Component({
  selector: 'app-section-title',
  template: `<h2 class="title-medium">{{ text() }}</h2><ng-content />`,
  styles: `
    :host { display: flex; align-items: center; gap: 12px; padding: 20px 4px 12px; }
    h2 { flex: 1; }
    :host ::ng-deep > :not(h2) { font-size: 15px; color: var(--muted); }
  `,
})
export class SectionTitle {
  readonly text = input.required<string>();
}
