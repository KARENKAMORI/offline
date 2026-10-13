import { computed, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { SwUpdate } from '@angular/service-worker';
import { NEVER } from 'rxjs';
import { App } from './app';
import { SyncService } from './core/sync/sync.service';

describe('App', () => {
  it('renders the FieldVisit tabs and starts background sync', async () => {
    const sync = {
      start: jasmine.createSpy('start'),
      syncNow: jasmine.createSpy('syncNow'),
      connection: computed(() => 'online'),
      phase: signal('idle'),
      lastError: signal(null),
      lastSyncedAt: signal(null),
      pendingCount: signal(0),
    };
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [
        provideRouter([]),
        { provide: SyncService, useValue: sync },
        { provide: SwUpdate, useValue: { isEnabled: false, versionUpdates: NEVER } },
      ],
    }).compileComponents();
    const fixture = TestBed.createComponent(App);
    fixture.detectChanges();
    const links = Array.from(
      (fixture.nativeElement as HTMLElement).querySelectorAll('nav a'),
    ).map((a) => a.textContent?.trim());
    expect(links).toEqual(['Visits', 'Patients', 'Sync', 'Profile']);
    expect(sync.start).toHaveBeenCalled();
  });
});
