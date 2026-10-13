import { TestBed } from '@angular/core/testing';
import { SwUpdate, type VersionEvent } from '@angular/service-worker';
import { Subject } from 'rxjs';
import { UpdateBar } from './update-bar';

describe('UpdateBar', () => {
  it('offers a reload once the service worker has a new version ready', async () => {
    const versionUpdates = new Subject<VersionEvent>();
    const sw = { isEnabled: true, versionUpdates, checkForUpdate: jasmine.createSpy().and.resolveTo(true) };
    TestBed.configureTestingModule({ imports: [UpdateBar], providers: [{ provide: SwUpdate, useValue: sw }] });
    const fixture = TestBed.createComponent(UpdateBar);
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.textContent).not.toContain('new version');
    expect(sw.checkForUpdate).toHaveBeenCalled();

    versionUpdates.next({ type: 'VERSION_DETECTED', version: { hash: 'b' } });
    fixture.detectChanges();
    expect(el.textContent).not.toContain('new version');

    versionUpdates.next({ type: 'VERSION_READY', currentVersion: { hash: 'a' }, latestVersion: { hash: 'b' } });
    fixture.detectChanges();
    expect(el.textContent).toContain('A new version of FieldVisit is ready.');
    expect(el.querySelector('button')?.textContent?.trim()).toBe('Reload');
  });
});
