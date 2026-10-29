import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
  PartialMatchRouteSnapshot,
  Route,
  Router,
  UrlSegment,
  UrlTree,
  provideRouter,
} from '@angular/router';
import { authGuard, guestGuard, roleGuard, safeReturnUrl } from './auth.guards';
import { AuthStore } from './auth.store';
import { Role, hasRole } from './roles';

/** The guards on their own (the routes use them in auth-routes.spec.ts). */
describe('auth guards', () => {
  function withUser(role: Role | null) {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([]),
        {
          provide: AuthStore,
          useValue: {
            isAuthenticated: signal(role !== null),
            can: (min: Role) => role !== null && hasRole(role, min),
          },
        },
      ],
    });
  }
  const segments = (...paths: string[]) => paths.map((p) => new UrlSegment(p, {}));
  const run = (guard: typeof authGuard, path: UrlSegment[] = []) =>
    TestBed.runInInjectionContext(() => guard({} as Route, path, {} as PartialMatchRouteSnapshot));
  const serialize = (result: unknown) => TestBed.inject(Router).serializeUrl(result as UrlTree);

  describe('authGuard', () => {
    it('lets a signed-in user in', () => {
      withUser('viewer');
      expect(run(authGuard, segments('farms'))).toBe(true);
    });

    it('sends a signed-out user to /login with the path to return to', () => {
      withUser(null);
      expect(serialize(run(authGuard, segments('farms', 'FARM01')))).toBe(
        '/login?returnUrl=%2Ffarms%2FFARM01',
      );
    });

    it('sends a signed-out user at the root to /login without a returnUrl', () => {
      withUser(null);
      expect(serialize(run(authGuard))).toBe('/login');
    });
  });

  describe('roleGuard', () => {
    it.each([
      ['viewer', 'owner', false],
      ['owner', 'owner', true],
      ['admin', 'owner', true],
      ['owner', 'admin', false],
    ] as const)('%s on a %s route: allowed = %s', (role, min, allowed) => {
      withUser(role);
      const result = run(roleGuard(min));
      if (allowed) expect(result).toBe(true);
      else expect(serialize(result)).toBe('/farms');
    });
  });

  describe('guestGuard', () => {
    it('shows /login while signed out', () => {
      withUser(null);
      expect(run(guestGuard)).toBe(true);
    });

    it('sends a signed-in user to the fleet', () => {
      withUser('viewer');
      expect(serialize(run(guestGuard))).toBe('/farms');
    });
  });

  describe('safeReturnUrl', () => {
    it.each([
      ['/turbines', '/turbines'],
      ['/farms/FARM01?x=1', '/farms/FARM01?x=1'],
      [undefined, '/farms'],
      [null, '/farms'],
      ['', '/farms'],
      ['https://evil.example', '/farms'],
      ['//evil.example/path', '/farms'],
      ['/login', '/farms'],
      ['/login?returnUrl=%2Flogin', '/farms'],
    ])('%s → %s', (value, expected) => {
      expect(safeReturnUrl(value)).toBe(expected);
    });
  });
});
