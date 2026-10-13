import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./patient-list').then((m) => m.PatientList) },
  { path: 'new', loadComponent: () => import('./patient-form').then((m) => m.PatientForm) },
  { path: ':id', loadComponent: () => import('./patient-detail').then((m) => m.PatientDetail) },
  { path: ':id/edit', loadComponent: () => import('./patient-form').then((m) => m.PatientForm) },
];
