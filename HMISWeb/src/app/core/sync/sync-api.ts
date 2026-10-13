import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, InjectionToken, inject } from '@angular/core';
import { firstValueFrom, timeout } from 'rxjs';
import { ProfileService } from '../profile.service';

export interface SyncConfig {
  /** Default server origin, e.g. "https://hmis.example.org". Empty means same origin (dev proxy). */
  apiBaseUrl: string;
  /** Background sync interval while online. */
  intervalMs: number;
  /** Delay between a local edit and the sync it triggers, so a burst of edits goes in one sync. */
  debounceMs: number;
  /**
   * Waits before retrying after each consecutive failure; the last one repeats, capped at
   * intervalMs. A network that has just come back usually needs a few seconds before requests work.
   */
  retryMs: readonly number[];
  /** A request that takes longer than this counts as a failed sync. */
  timeoutMs: number;
}

export const SYNC_CONFIG = new InjectionToken<SyncConfig>('SYNC_CONFIG', {
  providedIn: 'root',
  factory: () => ({
    apiBaseUrl: '',
    intervalMs: 60_000,
    debounceMs: 2_000,
    retryMs: [2_000, 5_000, 15_000, 30_000],
    timeoutMs: 20_000,
  }),
});

/** GET /api/sync/manifest/ */
export interface Manifest {
  server_time: string;
  /** Patient uuid to its sorted head hashes. */
  docs: Record<string, string[]>;
}

/** POST /api/sync/ */
export interface SyncReply {
  /** Patient uuid to a base64 sync message, or null when the server has nothing more to send. */
  docs: Record<string, string | null>;
  problems: Record<string, string[]>;
}

/** HTTP transport for HMIS/patients/sync_views.py. */
@Injectable({ providedIn: 'root' })
export class SyncApi {
  private readonly http = inject(HttpClient);
  private readonly config = inject(SYNC_CONFIG);
  private readonly profile = inject(ProfileService);

  /** The server address from Profile wins over the build-time default. */
  private get base(): string {
    return this.profile.profile().serverUrl || this.config.apiBaseUrl;
  }

  manifest(since: string | null): Promise<Manifest> {
    return firstValueFrom(
      this.http
        .get<Manifest>(`${this.base}/api/sync/manifest/`, { params: since ? { since } : {} })
        .pipe(timeout(this.config.timeoutMs)),
    );
  }

  /**
   * Whether the server answers at all. Any HTTP reply counts, even a 404, except the gateway
   * errors a proxy sends when it cannot reach the server either.
   */
  async reachable(): Promise<boolean> {
    try {
      await firstValueFrom(this.http.head(`${this.base}/api/`).pipe(timeout(5_000)));
      return true;
    } catch (err) {
      return err instanceof HttpErrorResponse && !isUnreachable(err.status);
    }
  }

  exchange(docs: Record<string, string>): Promise<SyncReply> {
    return firstValueFrom(
      this.http.post<SyncReply>(`${this.base}/api/sync/`, { docs }).pipe(timeout(this.config.timeoutMs)),
    );
  }
}

/** No reply at all (0), or a proxy or gateway that could not reach the server. */
export function isUnreachable(status: number): boolean {
  return status === 0 || status === 502 || status === 503 || status === 504;
}
