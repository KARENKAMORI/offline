import { Component, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { SwUpdate, type VersionReadyEvent } from '@angular/service-worker';
import { filter } from 'rxjs';

/**
 * The service worker serves the cached app first and downloads a new build in the background.
 * Tell the user when one is ready, instead of leaving them on the old screens until they reload.
 */
@Component({
  selector: 'app-update-bar',
  template: `
    @if (ready()) {
      <div class="bar" role="status">
        <span>A new version of FieldVisit is ready.</span>
        <button type="button" class="btn btn-text reload" (click)="reload()">Reload</button>
      </div>
    }
  `,
  styles: `
    .bar { position: fixed; left: 50%; transform: translateX(-50%); bottom: calc(var(--tabs-height) + 16px);
      z-index: 21; display: flex; align-items: center; gap: 12px; width: min(560px, calc(100% - 32px));
      padding: 6px 8px 6px 18px; border-radius: 4px; background: #31373a; color: #fff; font-size: 15px;
      box-shadow: 0 3px 8px rgb(0 0 0 / 0.2); }
    span { flex: 1; }
    .reload { color: #8fd3c5; }
    .reload:hover { background: rgb(255 255 255 / 0.08) !important; }
    @media (min-width: 900px) { .bar { bottom: 24px; } }
  `,
})
export class UpdateBar {
  private readonly updates = inject(SwUpdate);
  protected readonly ready = signal(false);

  constructor() {
    if (!this.updates.isEnabled) return;
    this.updates.versionUpdates
      .pipe(
        filter((e): e is VersionReadyEvent => e.type === 'VERSION_READY'),
        takeUntilDestroyed(),
      )
      .subscribe(() => this.ready.set(true));
    // Also check when the app starts, not only on the service worker's own schedule.
    void this.updates.checkForUpdate().catch(() => undefined);
  }

  protected reload(): void {
    document.location.reload();
  }
}
