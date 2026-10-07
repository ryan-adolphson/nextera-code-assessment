import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { TEST_API_BASE_URL, openFleet } from '../../fleet/testing';
import { AuthStore, SESSION_STORAGE_KEY } from './auth.store';
import { Role } from './roles';

const CLOCK = Date.parse('2026-01-03T00:00:00.000Z');
const LOGIN_URL = `${TEST_API_BASE_URL}/auth/login`;

/** Sign-in, the auth/role guards and the role-dependent UI, through the real routes. */
describe('auth routes and role-based UI', () => {
  let app: Awaited<ReturnType<typeof openFleet>>;
  const open = async (url: string, role: Role | null) =>
    (app = await openFleet(url, () => CLOCK, undefined, undefined, role));
  const url = () => TestBed.inject(Router).url;
  const q = <T extends HTMLElement = HTMLElement>(testId: string) =>
    app.root().querySelector<T>(`[data-testid=${testId}]`);
  /** Rendered after HTTP answers / navigations (the submit action is a pending task). */
  async function settle() {
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
    TestBed.tick();
    await app.stable();
  }
  const type = (testId: string, value: string) => {
    const input = q<HTMLInputElement>(testId)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    input.dispatchEvent(new Event('blur'));
  };
  const submit = async () => {
    q<HTMLButtonElement>('login-submit')!.click();
    TestBed.tick();
  };

  afterEach(() => {
    app.http.verify();
    localStorage.clear();
  });

  describe('signed out', () => {
    it('sends every fleet page to /login, remembering where it was going, without loading the fleet or opening SSE', async () => {
      await open('/farms/FARM01', null);
      expect(url()).toBe('/login?returnUrl=%2Ffarms%2FFARM01');
      expect(q('login-form')).not.toBeNull();
      expect(q('sidebar')).toBeNull();
      expect(app.sse.connect).not.toHaveBeenCalled();
      expect(app.api.farms).not.toHaveBeenCalled();
    });

    it('also from / and unknown URLs', async () => {
      await open('/', null);
      expect(url()).toMatch(/^\/login/);
      await app.harness.navigateByUrl('/nowhere');
      expect(url()).toMatch(/^\/login/);
    });
  });

  describe('login page', () => {
    it('has labelled email and password fields with autocomplete hints', async () => {
      await open('/login', null);
      expect(document.title).toBe('Sign in · Nextera');
      const email = q<HTMLInputElement>('login-email')!;
      const password = q<HTMLInputElement>('login-password')!;
      expect(email.type).toBe('email');
      expect(email.autocomplete).toBe('username');
      expect(password.type).toBe('password');
      expect(password.autocomplete).toBe('current-password');
      expect(app.root().querySelector(`label[for="${email.id}"]`)?.textContent).toContain('Email');
      expect(app.root().querySelector(`label[for="${password.id}"]`)?.textContent).toContain(
        'Password',
      );
    });

    it('validates before sending anything', async () => {
      await open('/login', null);
      await submit();
      await settle();
      expect(app.text(q('login-email-error'))).toBe('Enter your email address.');
      expect(app.text(q('login-password-error'))).toBe('Enter your password.');
      type('login-email', 'not-an-email');
      await settle();
      expect(app.text(q('login-email-error'))).toBe('Enter a valid email address.');
      app.http.expectNone(LOGIN_URL);
    });

    it('signs in, shows a busy state, and opens the page it was going to', async () => {
      await open('/turbines', null);
      type('login-email', 'owner@nextera.local');
      type('login-password', 'correct horse battery');
      await submit();

      const req = app.http.expectOne({ method: 'POST', url: LOGIN_URL });
      expect(req.request.body).toEqual({
        email: 'owner@nextera.local',
        password: 'correct horse battery',
      });
      expect(req.request.headers.has('Authorization')).toBe(false);
      TestBed.tick();
      expect(q<HTMLButtonElement>('login-submit')!.disabled).toBe(true);
      expect(app.text(q('login-submit'))).toBe('Signing in…');

      req.flush({
        accessToken: 'new-token',
        expiresAt: new Date(CLOCK + 24 * 3_600_000).toISOString(),
        user: { email: 'owner@nextera.local', role: 'owner' },
      });
      await settle();

      expect(url()).toBe('/turbines');
      expect(app.text(q('current-user-email'))).toBe('owner@nextera.local');
      expect(app.sse.connect).toHaveBeenCalled(); // the shell starts only now
      expect(JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY)!).accessToken).toBe('new-token');
    });

    it('shows the one generic message for a wrong password and clears the password', async () => {
      await open('/login', null);
      type('login-email', 'owner@nextera.local');
      type('login-password', 'wrong');
      await submit();
      app.http
        .expectOne(LOGIN_URL)
        .flush(
          { statusCode: 401, message: 'Invalid email or password' },
          { status: 401, statusText: 'Unauthorized' },
        );
      await settle();

      expect(url()).toBe('/login');
      expect(app.text(q('login-error'))).toBe('Invalid email or password.');
      expect(q('login-error')!.getAttribute('role')).toBe('alert');
      expect(q<HTMLInputElement>('login-email')!.value).toBe('owner@nextera.local');
      expect(q<HTMLInputElement>('login-password')!.value).toBe('');
      expect(q<HTMLButtonElement>('login-submit')!.disabled).toBe(false);
    });

    it('sends a signed-in user from /login to the fleet', async () => {
      await open('/login', 'viewer');
      expect(url()).toBe('/farms');
    });
  });

  describe('roles', () => {
    const navIds = () =>
      [...app.root().querySelectorAll<HTMLElement>('nav[aria-label=Main] a')].map(
        (a) => a.dataset['testid'],
      );

    it('hides Reporting from viewers and keeps them out of /reporting', async () => {
      await open('/reporting', 'viewer');
      expect(url()).toBe('/farms');
      expect(navIds()).toEqual(['nav-farms', 'nav-turbines', 'nav-alerting']);
    });

    it.each(['owner', 'admin'] as const)('shows Reporting to the %s', async (role) => {
      await open('/reporting', role);
      expect(url()).toBe('/reporting');
      expect(navIds()).toContain('nav-reporting');
    });

    it("shows the user's email and role in the nav", async () => {
      await open('/farms', 'viewer');
      expect(app.text(q('current-user-email'))).toBe('viewer@nextera.local');
      expect(app.text(q('current-user-role'))).toBe('Viewer');
      expect(q('current-user-role')!.dataset['role']).toBe('viewer');
    });

    it('signs out: forgets the session, goes to /login and closes the live connection', async () => {
      await open('/farms', 'owner');
      expect(app.sse.observed()).toBe(true);

      q<HTMLButtonElement>('sign-out')!.click();
      await settle();

      expect(url()).toBe('/login');
      expect(TestBed.inject(AuthStore).isAuthenticated()).toBe(false);
      expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
      expect(q('sidebar')).toBeNull();
      expect(app.sse.observed()).toBe(false); // the shell's FleetStore unsubscribed
    });

    it('signs out on a 401 from the API (token no longer valid)', async () => {
      await open('/alerting/rules', 'owner');
      TestBed.tick();
      app.http
        .expectOne(`${TEST_API_BASE_URL}/alert-configs`)
        .flush({}, { status: 401, statusText: 'Unauthorized' });
      await settle();
      expect(url()).toBe('/login');
      expect(localStorage.getItem(SESSION_STORAGE_KEY)).toBeNull();
    });

    describe('Rules page', () => {
      const rule = {
        id: 'r1',
        measurementMetric: 'gearboxTempC',
        comparison: 'above',
        valueMetric: 120,
        alertLevel: 'error',
        enabled: true,
      };
      async function openRules(role: Role) {
        await open('/alerting/rules', role);
        TestBed.tick();
        const req = app.http.expectOne(`${TEST_API_BASE_URL}/alert-configs`);
        expect(req.request.headers.get('Authorization')).toBe(`Bearer test-token-${role}`);
        req.flush([rule]);
        await settle();
      }

      it('shows viewers the rules without Add, Edit or Delete', async () => {
        await openRules('viewer');
        expect(app.root().querySelectorAll('[data-testid=rule]')).toHaveLength(1);
        expect(q('add-rule')).toBeNull();
        expect(q('edit-rule')).toBeNull();
        expect(q('delete-rule')).toBeNull();
      });

      it.each(['owner', 'admin'] as const)('gives the %s Add, Edit and Delete', async (role) => {
        await openRules(role);
        expect(q('add-rule')).not.toBeNull();
        expect(q('edit-rule')).not.toBeNull();
        expect(q('delete-rule')).not.toBeNull();
      });
    });
  });
});
