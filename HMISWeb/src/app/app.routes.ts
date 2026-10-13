import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'visits' },
  {
    path: 'visits',
    loadChildren: () => import('./features/visits/visits.routes').then((m) => m.routes),
  },
  {
    path: 'patients',
    loadChildren: () => import('./features/patients/patients.routes').then((m) => m.routes),
  },
  {
    path: 'sync',
    loadChildren: () => import('./features/sync/sync.routes').then((m) => m.routes),
  },
  {
    path: 'profile',
    loadComponent: () => import('./features/profile/profile-screen').then((m) => m.ProfileScreen),
  },
  { path: '**', redirectTo: 'visits' },
];
