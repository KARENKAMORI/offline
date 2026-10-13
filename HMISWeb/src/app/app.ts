import { Component, inject } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { SyncService } from './core/sync/sync.service';
import { ToastHost } from './shared/ui/toast';
import { UpdateBar } from './shared/ui/update-bar';

const TABS = [
  { label: 'Visits', link: '/visits' },
  { label: 'Patients', link: '/patients' },
  { label: 'Sync', link: '/sync' },
  { label: 'Profile', link: '/profile' },
];

@Component({
  selector: 'app-root',
  imports: [RouterOutlet, RouterLink, RouterLinkActive, ToastHost, UpdateBar],
  template: `
    <nav class="tabs" aria-label="Main">
      <span class="brand">FieldVisit</span>
      @for (t of tabs; track t.link) {
        <a [routerLink]="t.link" routerLinkActive="active" ariaCurrentWhenActive="page">
          <span class="dot" aria-hidden="true"></span>
          <span>{{ t.label }}</span>
        </a>
      }
    </nav>
    <main>
      <router-outlet />
    </main>
    <app-toast />
    <app-update-bar />
  `,
  styleUrl: './app.scss',
})
export class App {
  protected readonly tabs = TABS;

  constructor() {
    inject(SyncService).start();
  }
}
