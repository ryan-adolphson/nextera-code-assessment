import { InjectionToken } from '@angular/core';

/**
 * The client's current time in epoch ms. Inject it instead of calling `Date.now()` so tests
 * control "now" (the turbine page's time window ends at it).
 */
export const NOW = new InjectionToken<() => number>('NOW', {
  providedIn: 'root',
  factory: () => () => Date.now(),
});
