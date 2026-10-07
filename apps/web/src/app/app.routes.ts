import { Routes } from '@angular/router';

export const routes: Routes = [
  // The fleet overview lives at /farms, so the "Farms" nav item is active on every farm and
  // turbine page (all under /farms/...). Old links to / still land on it.
  { path: '', pathMatch: 'full', redirectTo: 'farms' },
  {
    // The shell owns the fleet state, live connection and side navigation, shared by every page.
    path: '',
    loadComponent: () => import('./fleet/fleet-shell').then((m) => m.FleetShell),
    children: [
      {
        path: 'farms',
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
      {
        path: 'turbines',
        title: 'Turbines · Nextera',
        // Filters and table in one window-high view: only the table rows scroll.
        data: { fillViewport: true },
        loadComponent: () => import('./fleet/turbine-list').then((m) => m.TurbineList),
      },
      // Alerting opens on its History tab (the side nav links to /alerting).
      { path: 'alerting', pathMatch: 'full', redirectTo: 'alerting/history' },
      {
        path: 'alerting/rules',
        title: 'Alert rules · Nextera',
        loadComponent: () => import('./alerting/alert-rules-page').then((m) => m.AlertRulesPage),
      },
      {
        path: 'alerting/history',
        title: 'Alert history · Nextera',
        // Range and table in one window-high view: only the table rows scroll.
        data: { fillViewport: true },
        loadComponent: () =>
          import('./alerting/alert-history-page').then((m) => m.AlertHistoryPage),
      },
      {
        path: 'reporting',
        title: 'Reporting · Nextera',
        loadComponent: () => import('./reporting/reporting-page').then((m) => m.ReportingPage),
      },
    ],
  },
  { path: '**', redirectTo: 'farms' },
];
