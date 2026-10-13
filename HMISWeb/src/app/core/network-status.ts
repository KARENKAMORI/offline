import { DestroyRef, Injectable, inject, signal } from '@angular/core';
import { Subject } from 'rxjs';
import { SyncApi } from './sync/sync-api';

/** How often to confirm the connection while online, and to look for it again while offline. */
const CHECK_ONLINE_MS = 15_000;
const CHECK_OFFLINE_MS = 3_000;

/**
 * Whether this device can reach the internet. The browser's navigator.onLine only says a network
 * interface is up (a Docker bridge or wifi without internet counts), so a short request to the
 * server confirms it. The browser's online/offline events trigger a check straight away.
 */
@Injectable({ providedIn: 'root' })
export class NetworkStatus {
  private readonly api = inject(SyncApi);
  private readonly destroyRef = inject(DestroyRef);

  readonly online = signal(navigator.onLine);
  /** Emits each time the device comes back online. */
  readonly reconnected = new Subject<void>();

  private timer?: ReturnType<typeof setTimeout>;
  private started = false;

  /** Starts checking. Call once at app start. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const onOnline = () => void this.check();
    const onOffline = () => this.set(false);
    const onVisible = () => document.visibilityState === 'visible' && void this.check();
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    document.addEventListener('visibilitychange', onVisible);
    this.destroyRef.onDestroy(() => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      document.removeEventListener('visibilitychange', onVisible);
      clearTimeout(this.timer);
      this.started = false;
    });
    void this.check();
  }

  /** Checks the connection now. */
  async check(): Promise<void> {
    clearTimeout(this.timer);
    this.set(navigator.onLine && (await this.api.reachable()));
    if (this.started) {
      this.timer = setTimeout(() => void this.check(), this.online() ? CHECK_ONLINE_MS : CHECK_OFFLINE_MS);
    }
  }

  /** A request just failed to reach the server: show offline and look again soon. */
  lost(): void {
    this.set(false);
    if (!this.started) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.check(), CHECK_OFFLINE_MS);
  }

  /** A request just reached the server. */
  confirmed(): void {
    this.set(true);
  }

  private set(online: boolean): void {
    const back = online && !this.online();
    this.online.set(online);
    if (back) this.reconnected.next();
  }
}
