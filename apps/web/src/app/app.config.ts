import { provideHttpClient, withFetch } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes';
import { API_BASE_URL } from './core/api-base-url';
import { provideIcons } from './ui/icons';

// Zoneless (Angular 21 default): change detection is driven by signals, no zone.js.
// `apiBaseUrl` is resolved before bootstrap (src/main.ts, core/runtime-config.ts).
export function appConfig(apiBaseUrl: string): ApplicationConfig {
  return {
    providers: [
      provideBrowserGlobalErrorListeners(),
      provideRouter(routes, withComponentInputBinding()), // route params as component inputs
      provideHttpClient(withFetch()),
      provideIcons(),
      { provide: API_BASE_URL, useValue: apiBaseUrl },
    ],
  };
}
