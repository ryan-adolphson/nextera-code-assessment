import { InjectionToken } from '@angular/core';

/** Base URL of the API, e.g. https://api.example.com/api (no trailing slash). */
export const API_BASE_URL = new InjectionToken<string>('API_BASE_URL');
