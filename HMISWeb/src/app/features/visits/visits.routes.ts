import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./visits-home').then((m) => m.VisitsHome) },
  { path: 'all', loadComponent: () => import('./all-visits').then((m) => m.AllVisits) },
  { path: 'new', loadComponent: () => import('./visit-form').then((m) => m.VisitForm) },
  { path: ':id/edit', redirectTo: ':id' },
  { path: ':id', loadComponent: () => import('./visit-form').then((m) => m.VisitForm) },
];
