import { ROLES, type Role } from '@nextera/shared';
import { TokenService } from '../src/auth/token.service.js';
import {
  TEST_PASSWORD,
  createTestApp,
  eventsUrl,
  openSse,
  publishReading,
  type TestApp,
} from './helpers.js';

const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
const DAY = 'from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z';

/** Sign-in, the access matrix per role, and SSE authentication. */
describe('Auth (e2e)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.prisma.user.updateMany({ data: { active: true } });
    await t.app.close();
  });

  const login = (email: string, password: string) =>
    fetch(`${t.url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

  describe('POST /api/auth/login', () => {
    it.each(ROLES)(
      'signs in the seeded %s and the token works',
      async (role) => {
        const res = await login(
          ` ${role.toUpperCase()}@nextera.local `,
          TEST_PASSWORD,
        );
        expect(res.status).toBe(200);
        const body = (await res.json()) as {
          accessToken: string;
          expiresAt: string;
          user: unknown;
        };
        expect(body.user).toEqual({ email: `${role}@nextera.local`, role });
        const ttl = new Date(body.expiresAt).getTime() - Date.now();
        expect(ttl).toBeGreaterThan(24 * 3600_000 - 60_000);

        const me = await fetch(`${t.url}/api/auth/me`, {
          headers: { Authorization: `Bearer ${body.accessToken}` },
        });
        expect(me.status).toBe(200);
        expect(await me.json()).toEqual({
          email: `${role}@nextera.local`,
          role,
        });
      },
    );

    it('answers a wrong password and an unknown email with the same 401', async () => {
      const wrong = await login('owner@nextera.local', 'not-the-password');
      const unknown = await login('nobody@nextera.local', TEST_PASSWORD);
      for (const res of [wrong, unknown]) {
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({
          statusCode: 401,
          error: 'Unauthorized',
          message: 'Invalid email or password',
        });
      }
    });

    it('refuses an inactive user, and their existing token stops working', async () => {
      await t.prisma.user.update({
        where: { email: 'viewer@nextera.local' },
        data: { active: false },
      });
      try {
        expect(
          (await login('viewer@nextera.local', TEST_PASSWORD)).status,
        ).toBe(401);
        const me = await fetch(`${t.url}/api/auth/me`, {
          headers: t.auth('viewer'),
        });
        expect(me.status).toBe(401);
      } finally {
        await t.prisma.user.update({
          where: { email: 'viewer@nextera.local' },
          data: { active: true },
        });
      }
    });

    it.each([
      ['no body', {}],
      ['an invalid email', { email: 'nope', password: 'x' }],
      ['an empty password', { email: 'owner@nextera.local', password: '' }],
      [
        'an extra field',
        { email: 'owner@nextera.local', password: 'x', role: 'admin' },
      ],
    ])('rejects %s with 400', async (_case, body) => {
      const res = await fetch(`${t.url}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      expect(res.status).toBe(400);
    });
  });

  describe('access matrix', () => {
    type Route = [method: string, path: string, minRole: Role, body?: object];
    const rule = {
      measurementMetric: 'rotorRpm',
      comparison: 'above',
      valueMetric: 30,
      alertLevel: 'info',
    };
    // A request a role may make returns its normal status (here 200/201/204/404 for an unknown
    // id): never 401, and never the role 404 (which says "Cannot <METHOD> <url>").
    const ROUTES: Route[] = [
      ['GET', '/api/auth/me', 'viewer'],
      ['GET', '/api/farms', 'viewer'],
      ['GET', '/api/turbines/TURB001/telemetry', 'viewer'],
      ['GET', '/api/turbines/TURB001/telemetry/stats', 'viewer'],
      ['GET', `/api/alerts?${DAY}`, 'viewer'],
      ['GET', '/api/alert-configs', 'viewer'],
      ['GET', `/api/alert-configs/${UNKNOWN_ID}`, 'viewer'],
      ['GET', `/api/reports/telemetry?turbineId=TURB001&${DAY}`, 'owner'],
      ['POST', '/api/alert-configs', 'owner', rule],
      [
        'PATCH',
        `/api/alert-configs/${UNKNOWN_ID}`,
        'owner',
        { valueMetric: 1 },
      ],
      ['DELETE', `/api/alert-configs/${UNKNOWN_ID}`, 'owner'],
    ];

    beforeEach(async () => {
      await t.prisma
        .$executeRaw`TRUNCATE TABLE telemetry_alerts, alerts_config`;
    });

    const call = (
      [method, path, , body]: Route,
      headers: Record<string, string>,
    ) =>
      fetch(`${t.url}${path}`, {
        method,
        headers: {
          ...headers,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });

    it.each(ROUTES)(
      '%s %s without a token: 401 with WWW-Authenticate',
      async (...route) => {
        const res = await call(route, {});
        expect(res.status).toBe(401);
        expect(res.headers.get('www-authenticate')).toBe('Bearer');
        expect(await res.json()).toEqual({
          statusCode: 401,
          message: 'Unauthorized',
        });
      },
    );

    it.each(ROUTES)(
      '%s %s with a forged or expired token: 401',
      async (...route) => {
        const [header, payload] = t.tokens.admin.split('.');
        const forged = `${header}.${payload}.${'A'.repeat(43)}`;
        const expired = (
          await t.app.get(TokenService).sign(
            await t.prisma.user.findUniqueOrThrow({
              where: { email: 'admin@nextera.local' },
            }),
            new Date(Date.now() - 25 * 3600_000),
          )
        ).token;
        for (const token of [forged, expired]) {
          expect(
            (await call(route, { Authorization: `Bearer ${token}` })).status,
          ).toBe(401);
        }
      },
    );

    const CASES: [Role, ...Route][] = ROUTES.flatMap((route) =>
      ROLES.map((role): [Role, ...Route] => [role, ...route]),
    );
    it.each(CASES)('%s: %s %s (minimum %s)', async (role, ...route) => {
      const [method, path, minRole] = route;
      const res = await call(route, t.auth(role));
      const text = await res.text();
      const allowed = ROLES.indexOf(role) >= ROLES.indexOf(minRole);
      if (allowed) {
        expect(res.status).toBeLessThan(500);
        expect(res.status).not.toBe(401);
        expect(text).not.toContain(`Cannot ${method}`);
      } else {
        // Indistinguishable from a route that doesn't exist.
        expect(res.status).toBe(404);
        expect(JSON.parse(text)).toEqual({
          statusCode: 404,
          error: 'Not Found',
          message: `Cannot ${method} ${path}`,
        });
      }
    });

    it('a viewer gets the same 404 for a forbidden route as for an unknown one', async () => {
      const forbidden = await fetch(`${t.url}/api/reports/telemetry`, {
        headers: t.auth('viewer'),
      });
      const unknown = await fetch(`${t.url}/api/reports/nothing`, {
        headers: t.auth('viewer'),
      });
      expect(forbidden.status).toBe(404);
      expect(unknown.status).toBe(404);
      expect(Object.keys(await forbidden.json())).toEqual(
        Object.keys(await unknown.json()),
      );
    });

    it('keeps the health probes public', async () => {
      expect((await fetch(`${t.url}/api/health/live`)).status).toBe(200);
      expect((await fetch(`${t.url}/api/health/ready`)).status).toBe(200);
    });

    it('accepts ?access_token= on GET /api/events only', async () => {
      const res = await fetch(
        `${t.url}/api/farms?access_token=${encodeURIComponent(t.tokens.admin)}`,
      );
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/events (SSE)', () => {
    it('refuses a stream without a token, or with a bad one (401, before streaming)', async () => {
      for (const url of [
        `${t.url}/api/events`,
        `${t.url}/api/events?access_token=nope`,
      ]) {
        const res = await fetch(url);
        expect(res.status).toBe(401);
        expect(res.headers.get('content-type')).toContain('application/json');
      }
    });

    it.each(ROLES)('streams to a %s with ?access_token=', async (role) => {
      const sse = await openSse(eventsUrl(t, role));
      try {
        expect(sse.response.status).toBe(200);
        const reading = await publishReading(t);
        expect(
          JSON.parse((await sse.nextEvent('telemetry.received')).data).id,
        ).toBe(reading.id);
      } finally {
        sse.close();
      }
    });

    it('also accepts the Authorization header', async () => {
      const sse = await openSse(`${t.url}/api/events`, t.auth('viewer'));
      try {
        expect(sse.response.status).toBe(200);
      } finally {
        sse.close();
      }
    });

    it('ends the stream when the token expires', async () => {
      const viewer = await t.prisma.user.findUniqueOrThrow({
        where: { email: 'viewer@nextera.local' },
      });
      // Issued 24 h minus 2 s ago: valid for 2 more seconds.
      const { token, expiresAt } = await t.app
        .get(TokenService)
        .sign(viewer, new Date(Date.now() - 24 * 3600_000 + 2_000));
      const sse = await openSse(`${t.url}/api/events?access_token=${token}`);
      try {
        expect(sse.response.status).toBe(200);
        await expect(sse.nextEvent(undefined, 6_000)).rejects.toThrow(
          'SSE stream ended',
        );
        expect(Date.now()).toBeGreaterThanOrEqual(expiresAt.getTime() - 1_000);
      } finally {
        sse.close();
      }
    });
  });

  describe('CORS', () => {
    it('allows the Authorization header in a preflight from the web origin, without credentials', async () => {
      const res = await fetch(`${t.url}/api/farms`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'http://localhost:4200',
          'Access-Control-Request-Method': 'GET',
          'Access-Control-Request-Headers': 'authorization',
        },
      });
      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe(
        'http://localhost:4200',
      );
      expect(
        res.headers.get('access-control-allow-headers')?.toLowerCase(),
      ).toContain('authorization');
      expect(res.headers.get('access-control-allow-credentials')).toBeNull();
    });
  });
});
