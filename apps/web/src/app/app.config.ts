import { provideHttpClient, withInterceptors } from '@angular/common/http';
import { ApplicationConfig, provideBrowserGlobalErrorListeners } from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { routes } from './app.routes';
import { API_BASE_URL } from './core/api-base-url';
import { authInterceptor } from './core/auth/auth.interceptor';
import { provideIcons } from './ui/icons';

// Zoneless (the Angular default since 21): change detection is driven by signals, no zone.js.
// HttpClient uses the fetch backend by default (Angular 22).
// `apiBaseUrl` is resolved before bootstrap (src/main.ts, core/runtime-config.ts).
export function appConfig(apiBaseUrl: string): ApplicationConfig {
  return {
    providers: [
      provideBrowserGlobalErrorListeners(),
      provideRouter(routes, withComponentInputBinding()), // route params as component inputs
      // The Bearer token on API requests; a 401 signs out (core/auth/auth.interceptor.ts).
      provideHttpClient(withInterceptors([authInterceptor])),
      provideIcons(),
      { provide: API_BASE_URL, useValue: apiBaseUrl },
    ],
  };
}
