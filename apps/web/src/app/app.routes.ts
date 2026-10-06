import { Routes } from '@angular/router';

export const routes: Routes = [
  {
    // The shell owns the fleet state and live connection, shared by both pages below.
    path: '',
    loadComponent: () => import('./fleet/fleet-shell').then((m) => m.FleetShell),
    children: [
      {
        path: '',
        title: 'Fleet overview · Nextera',
        loadComponent: () => import('./fleet/fleet-overview').then((m) => m.FleetOverview),
      },
      {
        path: 'farms/:farmId',
        title: 'Farm · Nextera',
        loadComponent: () => import('./fleet/farm-page').then((m) => m.FarmPage),
      },
      {
        path: 'farms/:farmId/turbines/:turbineId',
        title: 'Turbine · Nextera',
        loadComponent: () => import('./fleet/turbine-page').then((m) => m.TurbinePage),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];
