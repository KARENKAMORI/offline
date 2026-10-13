import { Injectable, inject, signal } from '@angular/core';
import { DEFAULT_DEVICE_NAME, DocStore } from './db/doc-store';
import { HMIS_DB } from './db/hmis-db';

export interface Profile {
  workerName: string;
  area: string;
  deviceName: string;
  /** Server origin; '' means the server this app was loaded from. */
  serverUrl: string;
}

/** Who uses this browser and where it syncs to. Stored in the meta table. */
@Injectable({ providedIn: 'root' })
export class ProfileService {
  private readonly db = inject(HMIS_DB);
  private readonly store = inject(DocStore);

  readonly profile = signal<Profile>({
    workerName: '',
    area: '',
    deviceName: DEFAULT_DEVICE_NAME,
    serverUrl: '',
  });
  readonly deviceId = signal('');
  readonly loaded: Promise<void>;

  constructor() {
    this.loaded = this.load();
  }

  private async load(): Promise<void> {
    const identity = await this.store.identity();
    const rows = await this.db.meta.bulkGet(['workerName', 'area', 'serverUrl']);
    this.deviceId.set(identity.deviceId);
    this.profile.set({
      workerName: rows[0]?.value ?? '',
      area: rows[1]?.value ?? '',
      deviceName: identity.deviceName,
      serverUrl: rows[2]?.value ?? '',
    });
  }

  async save(p: Profile): Promise<void> {
    const next: Profile = {
      workerName: p.workerName.trim(),
      area: p.area.trim(),
      deviceName: p.deviceName.trim() || DEFAULT_DEVICE_NAME,
      serverUrl: p.serverUrl.trim().replace(/\/+$/, ''),
    };
    await this.db.meta.bulkPut([
      { key: 'workerName', value: next.workerName },
      { key: 'area', value: next.area },
      { key: 'serverUrl', value: next.serverUrl },
    ]);
    await this.store.setDeviceName(next.deviceName);
    this.profile.set(next);
  }
}
