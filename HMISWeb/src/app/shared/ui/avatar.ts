import { Component, computed, input } from '@angular/core';

@Component({
  selector: 'app-avatar',
  template: `<span aria-hidden="true">{{ letter() }}</span>`,
  styles: `
    :host { flex: none; display: inline-grid; place-items: center; width: 48px; height: 48px;
      border-radius: 50%; background: var(--teal-soft); color: var(--teal); font-weight: 800; font-size: 18px; }
  `,
})
export class Avatar {
  readonly name = input.required<string>();
  protected readonly letter = computed(() => this.name().trim().charAt(0).toUpperCase() || '?');
}
