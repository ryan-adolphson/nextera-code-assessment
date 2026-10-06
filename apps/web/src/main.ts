import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { loadApiBaseUrl } from './app/core/runtime-config';
import { environment } from './environments/environment';

// The API base URL is runtime config in production (/config.json from the web container), so it is
// resolved before bootstrapping and provided as a plain value (API_BASE_URL).
loadApiBaseUrl(environment)
  .then((apiBaseUrl) => bootstrapApplication(App, appConfig(apiBaseUrl)))
  .catch((err) => console.error(err));
