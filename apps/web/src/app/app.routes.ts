import { Routes } from '@angular/router';
import { authGuard, guestGuard, roleGuard } from './core/auth/auth.guards';

export const routes: Routes = [
  // Outside the shell: no fleet state or SSE connection before signing in.
  {
    path: 'login',
    title: 'Sign in · Nextera',
    canMatch: [guestGuard],
    loadComponent: () => import('./core/auth/login-page').then((m) => m.LoginPage),
  },
  // The fleet overview lives at /farms, so the "Farms" nav item is active on every farm and
  // turbine page (all under /farms/...). Old links to / still land on it.
  { path: '', pathMatch: 'full', redirectTo: 'farms' },
  {
    // The shell owns the fleet state, live connection and side navigation, shared by every page.
    // Signed-in users only (else /login), so FleetStore and its SSE connection start only then.
    path: '',
    canMatch: [authGuard],
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
        // The farm's History tab: daily power candles (the page renames the farm in the title).
        path: 'farms/:farmId/history',
        title: (route) => `${route.paramMap.get('farmId')} · History · Nextera`,
        loadComponent: () =>
          import('./farm-history/farm-history-page').then((m) => m.FarmHistoryPage),
      },
      {
        // The farm's Weather history tab (Overview is /farms/:farmId). The page renames the farm
        // in the title once its name is known.
        path: 'farms/:farmId/weather',
        title: (route) => `${route.paramMap.get('farmId')} · Weather history · Nextera`,
        loadComponent: () =>
          import('./weather/farm-weather-history-page').then((m) => m.FarmWeatherHistoryPage),
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
      // Unallocated turbines (owners and admins; the API answers viewers 404): Pending first.
      {
        path: 'unallocated',
        canMatch: [roleGuard('owner')],
        children: [
          { path: '', pathMatch: 'full', redirectTo: 'pending' },
          {
            path: 'pending',
            title: 'Unallocated turbines · Nextera',
            loadComponent: () =>
              import('./unallocated/unallocated-pending-page').then(
                (m) => m.UnallocatedPendingPage,
              ),
          },
          {
            path: 'blocked',
            title: 'Blocked turbines · Nextera',
            loadComponent: () =>
              import('./unallocated/unallocated-blocked-page').then(
                (m) => m.UnallocatedBlockedPage,
              ),
          },
        ],
      },
      {
        path: 'reporting',
        title: 'Reporting · Nextera',
        canMatch: [roleGuard('owner')], // owners and admins (the API answers viewers 404)
        loadComponent: () => import('./reporting/reporting-page').then((m) => m.ReportingPage),
      },
      {
        path: 'settings',
        title: 'Settings · Nextera',
        loadComponent: () => import('./settings/settings-page').then((m) => m.SettingsPage),
      },
    ],
  },
  { path: '**', redirectTo: 'farms' },
];
