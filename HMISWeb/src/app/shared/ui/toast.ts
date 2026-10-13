import { Component, Injectable, inject, signal } from '@angular/core';

/** SnackBar equivalent: one message at a time along the bottom of the screen. */
@Injectable({ providedIn: 'root' })
export class Toast {
  readonly message = signal<string | null>(null);
  private timer?: ReturnType<typeof setTimeout>;

  show(message: string): void {
    clearTimeout(this.timer);
    this.message.set(message);
    this.timer = setTimeout(() => this.message.set(null), 4000);
  }

  error(err: unknown): void {
    this.show(err instanceof Error ? err.message : String(err));
  }
}

@Component({
  selector: 'app-toast',
  template: `
    <div class="toast" role="status" aria-live="polite">
      @if (toast.message(); as m) {
        <span>{{ m }}</span>
      }
    </div>
  `,
  styles: `
    .toast { position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(var(--tabs-height) + 16px);
      z-index: 20; max-width: min(560px, calc(100% - 32px)); pointer-events: none; }
    span { display: block; padding: 14px 18px; border-radius: 4px; background: #31373a; color: #fff;
      font-size: 15px; box-shadow: 0 3px 8px rgb(0 0 0 / 0.2); }
    @media (min-width: 900px) { .toast { bottom: 24px; } }
  `,
})
export class ToastHost {
  protected readonly toast = inject(Toast);
}
