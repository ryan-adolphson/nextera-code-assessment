import { inject } from '@angular/core';
import { CanMatchFn, Router } from '@angular/router';
import { AuthStore } from './auth.store';
import { Role } from './roles';

/** Signed in, else /login (remembering where the user was going). Guards the FleetShell. */
export const authGuard: CanMatchFn = (_route, segments) => {
  if (inject(AuthStore).isAuthenticated()) return true;
  const path = segments.map((s) => s.path).join('/');
  return inject(Router).createUrlTree(['/login'], {
    queryParams: path ? { returnUrl: `/${path}` } : {},
  });
};

/** At least `minRole`, else the fleet overview (the API answers 404 for such routes anyway). */
export const roleGuard =
  (minRole: Role): CanMatchFn =>
  () =>
    inject(AuthStore).can(minRole) || inject(Router).createUrlTree(['/farms']);

/** /login only while signed out; a signed-in user goes to the fleet. */
export const guestGuard: CanMatchFn = () =>
  !inject(AuthStore).isAuthenticated() || inject(Router).createUrlTree(['/farms']);

/** A same-app path to return to after signing in (never another origin), else /farms. */
export function safeReturnUrl(value: string | null | undefined): string {
  return value && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/login')
    ? value
    : '/farms';
}
