import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./sync-screen').then((m) => m.SyncScreen) },
  { path: 'pending', loadComponent: () => import('./pending-changes').then((m) => m.PendingChanges) },
  { path: 'history', loadComponent: () => import('./sync-history').then((m) => m.SyncHistory) },
];
