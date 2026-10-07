import { ALERT_CONFIG_CHANGED } from '@nextera/shared';
import { createTestApp, openSse, type TestApp } from './helpers.js';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The alerts_config table and its enums, against the migrated Postgres. */
describe('alerts_config (e2e, real Postgres)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await t.prisma.$executeRaw`TRUNCATE TABLE alert_history, alerts_config`;
  });

  it('stores a threshold through Prisma with a database-generated UUID v4', async () => {
    const row = await t.prisma.alertConfig.create({
      data: {
        measurementMetric: 'gearboxTempC',
        comparison: 'above',
        valueMetric: 120.5,
        alertLevel: 'error',
      },
    });

    expect(row).toMatchObject({
      measurementMetric: 'gearboxTempC',
      comparison: 'above',
      valueMetric: 120.5,
      alertLevel: 'error',
    });
    expect(row.id).toMatch(UUID_V4);
  });

  it('stores the telemetry column names as the metric enum values in Postgres', async () => {
    const [row] = await t.prisma.$queryRaw<
      { id: string; measurement_metric: string }[]
    >`
      INSERT INTO alerts_config (measurement_metric, comparison, value_metric, alert_level)
      VALUES ('power_output_kw', 'below', 100, 'info')
      RETURNING id::text, measurement_metric::text`;

    expect(row.id).toMatch(UUID_V4);
    expect(row.measurement_metric).toBe('power_output_kw');
    const viaPrisma = await t.prisma.alertConfig.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(viaPrisma.measurementMetric).toBe('powerOutputKw');
  });

  it.each([
    ['an unknown metric', `'not_a_metric'`, `'above'`, `'warn'`],
    ['an unknown comparison', `'rotor_rpm'`, `'equal'`, `'warn'`],
    ['an unknown alert level', `'rotor_rpm'`, `'above'`, `'critical'`],
  ])('rejects %s', async (_case, metric, comparison, level) => {
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO alerts_config (measurement_metric, comparison, value_metric, alert_level)
         VALUES (${metric}, ${comparison}, 1, ${level})`,
      ),
    ).rejects.toThrow(/invalid input value for enum/);
  });

  it('requires every column except id', async () => {
    await expect(
      t.prisma.$executeRaw`
        INSERT INTO alerts_config (measurement_metric, comparison, alert_level)
        VALUES ('rotor_rpm', 'above', 'warn')`,
    ).rejects.toThrow(/value_metric/);
  });

  it('allows one rule per metric, comparison and level (unique constraint)', async () => {
    const rule = {
      measurementMetric: 'rotorRpm',
      comparison: 'above',
      valueMetric: 18,
      alertLevel: 'warn',
    } as const;
    await t.prisma.alertConfig.create({ data: rule });

    await expect(
      t.prisma.alertConfig.create({ data: { ...rule, valueMetric: 20 } }),
    ).rejects.toMatchObject({ code: 'P2002' });
    // Another level or direction is a different rule.
    await t.prisma.alertConfig.create({
      data: { ...rule, alertLevel: 'error' },
    });
    await t.prisma.alertConfig.create({
      data: { ...rule, comparison: 'below' },
    });
    expect(await t.prisma.alertConfig.count()).toBe(3);
  });
});

/** /api/alert-configs: CRUD over HTTP, validation, CORS and the change event. */
describe('Alert configs API (e2e)', () => {
  const ORIGIN = 'http://localhost:4200';
  const UNKNOWN_ID = '00000000-0000-4000-8000-000000000000';
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await t.prisma.$executeRaw`TRUNCATE TABLE alert_history, alerts_config`;
  });

  const request = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    fetch(`${t.url}/api/alert-configs${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const gearboxError = {
    measurementMetric: 'gearboxTempC',
    comparison: 'above',
    valueMetric: 120.5,
    alertLevel: 'error',
  };

  const create = async (rule: object = gearboxError) => {
    const res = await request('POST', '', rule);
    expect(res.status).toBe(201);
    return (await res.json()) as { id: string } & Record<string, unknown>;
  };

  it('creates, reads, updates and deletes a rule', async () => {
    const created = await create();
    expect(created).toEqual({
      id: expect.stringMatching(UUID_V4),
      ...gearboxError,
      enabled: true, // the database default
    });

    expect(await (await request('GET', `/${created.id}`)).json()).toEqual(
      created,
    );

    const patched = await request('PATCH', `/${created.id}`, {
      valueMetric: 115,
    });
    expect(patched.status).toBe(200);
    expect(await patched.json()).toEqual({ ...created, valueMetric: 115 });

    const deleted = await request('DELETE', `/${created.id}`);
    expect(deleted.status).toBe(204);
    expect(await deleted.text()).toBe('');
    expect((await request('GET', `/${created.id}`)).status).toBe(404);
  });

  it('disables and re-enables a rule, and accepts enabled on create', async () => {
    const created = await create();
    const disabled = await request('PATCH', `/${created.id}`, {
      enabled: false,
    });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toEqual({ ...created, enabled: false });
    const enabled = await request('PATCH', `/${created.id}`, { enabled: true });
    expect(((await enabled.json()) as { enabled: boolean }).enabled).toBe(true);

    const off = await create({
      ...gearboxError,
      alertLevel: 'warn',
      valueMetric: 90,
      enabled: false,
    });
    expect(off.enabled).toBe(false);

    const bad = await request('PATCH', `/${created.id}`, { enabled: 'no' });
    expect(bad.status).toBe(400);
    expect(JSON.stringify(await bad.json())).toContain(
      'enabled must be a boolean',
    );
  });

  it('refuses to delete a rule with alert history (409, disable it instead) and keeps both', async () => {
    const created = await create();
    await t.prisma.$executeRaw`
      INSERT INTO farms (id, name, latitude, longitude)
      VALUES ('FARM-AH', 'History farm', 1, 1) ON CONFLICT DO NOTHING`;
    const turbine = await t.prisma.turbine.upsert({
      where: { turbineId: 'TURB-AH' },
      create: {
        turbineId: 'TURB-AH',
        farmId: 'FARM-AH',
        latitude: 1,
        longitude: 1,
      },
      update: {},
    });
    await t.prisma.alertHistory.create({
      data: { turbineId: turbine.id, alertId: created.id },
    });

    const res = await request('DELETE', `/${created.id}`);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toBe(
      `Alert config ${created.id} has alert history and cannot be deleted; disable it instead (enabled: false)`,
    );
    expect((await request('GET', `/${created.id}`)).status).toBe(200);
    expect(
      await t.prisma.alertHistory.count({ where: { alertId: created.id } }),
    ).toBe(1);

    // Disabling it works.
    const disabled = await request('PATCH', `/${created.id}`, {
      enabled: false,
    });
    expect(disabled.status).toBe(200);
  });

  it('lists rules by metric, then level severity, then value', async () => {
    await create({ ...gearboxError, alertLevel: 'warn', valueMetric: 105 });
    await create(gearboxError);
    await create({
      measurementMetric: 'powerOutputKw',
      comparison: 'below',
      valueMetric: 50,
      alertLevel: 'info',
    });
    await create({
      measurementMetric: 'gearboxTempC',
      comparison: 'below',
      valueMetric: -20,
      alertLevel: 'warn',
    });

    const list = (await (await request('GET', '')).json()) as Record<
      string,
      unknown
    >[];
    expect(
      list.map((r) => [r.measurementMetric, r.alertLevel, r.valueMetric]),
    ).toEqual([
      ['powerOutputKw', 'info', 50],
      ['gearboxTempC', 'warn', -20],
      ['gearboxTempC', 'warn', 105],
      ['gearboxTempC', 'error', 120.5],
    ]);
  });

  it('accepts writes without credentials (known gap: no auth yet)', async () => {
    const created = await create(); // no Authorization header
    expect(
      (await request('PATCH', `/${created.id}`, { valueMetric: 1 })).status,
    ).toBe(200);
    expect((await request('DELETE', `/${created.id}`)).status).toBe(204);
  });

  describe('validation', () => {
    it.each([
      [
        'an unknown metric',
        { ...gearboxError, measurementMetric: 'gearbox_temp_c' },
        /measurementMetric must be one of/,
      ],
      [
        'an unknown comparison',
        { ...gearboxError, comparison: 'equals' },
        /comparison must be one of/,
      ],
      [
        'an unknown level',
        { ...gearboxError, alertLevel: 'critical' },
        /alertLevel must be one of/,
      ],
      [
        'a numeric string',
        { ...gearboxError, valueMetric: '120' },
        /valueMetric must be a finite number/,
      ],
      [
        'a missing value',
        { ...gearboxError, valueMetric: undefined },
        /valueMetric must be a finite number/,
      ],
      [
        'an extra field',
        { ...gearboxError, id: UNKNOWN_ID },
        /property id should not exist/,
      ],
    ])('rejects %s with 400', async (_case, body, message) => {
      const res = await request('POST', '', body);
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toMatch(message);
      expect(await t.prisma.alertConfig.count()).toBe(0);
    });

    it('rejects an empty or null PATCH with 400', async () => {
      const { id } = await create();
      expect((await request('PATCH', `/${id}`, {})).status).toBe(400);
      const nulled = await request('PATCH', `/${id}`, { valueMetric: null });
      expect(nulled.status).toBe(400);
      expect(JSON.stringify(await nulled.json())).toMatch(
        /valueMetric must be a finite number/,
      );
    });

    it.each(['GET', 'PATCH', 'DELETE'])(
      'rejects a non-UUID id with 400 (%s)',
      async (method) => {
        const res = await request(
          method,
          '/123',
          method === 'PATCH' ? { valueMetric: 1 } : undefined,
        );
        expect(res.status).toBe(400);
        expect((await res.json()).message).toMatch(/uuid is expected/i);
      },
    );

    it.each([
      ['GET', undefined],
      ['PATCH', { valueMetric: 1 }],
      ['DELETE', undefined],
    ])('returns 404 for an unknown id (%s)', async (method, body) => {
      const res = await request(method, `/${UNKNOWN_ID}`, body);
      expect(res.status).toBe(404);
      expect((await res.json()).message).toBe(
        `Alert config ${UNKNOWN_ID} not found`,
      );
    });
  });

  describe('duplicates', () => {
    it('rejects a second rule for the same metric, comparison and level with 409', async () => {
      await create();
      const res = await request('POST', '', {
        ...gearboxError,
        valueMetric: 130,
      });
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        statusCode: 409,
        error: 'Conflict',
        message:
          'An alert rule for gearboxTempC above at level error already exists',
      });
    });

    it('rejects a PATCH that would duplicate another rule with 409 and keeps it unchanged', async () => {
      await create();
      const warn = await create({
        ...gearboxError,
        alertLevel: 'warn',
        valueMetric: 105,
      });

      const res = await request('PATCH', `/${warn.id}`, {
        alertLevel: 'error',
      });
      expect(res.status).toBe(409);
      expect((await res.json()).message).toBe(
        'An alert rule for gearboxTempC above at level error already exists',
      );
      expect(
        (await (await request('GET', `/${warn.id}`)).json()).alertLevel,
      ).toBe('warn');
    });
  });

  describe('CORS', () => {
    it.each(['POST', 'PATCH', 'DELETE'])(
      'allows a %s preflight with a JSON body from the web origin',
      async (method) => {
        const res = await fetch(`${t.url}/api/alert-configs/${UNKNOWN_ID}`, {
          method: 'OPTIONS',
          headers: {
            Origin: ORIGIN,
            'Access-Control-Request-Method': method,
            'Access-Control-Request-Headers': 'content-type',
          },
        });
        expect(res.status).toBe(204);
        expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
        expect(res.headers.get('access-control-allow-methods')).toContain(
          method,
        );
        expect(
          res.headers.get('access-control-allow-headers')?.toLowerCase(),
        ).toContain('content-type');
      },
    );

    it('refuses a preflight from another origin', async () => {
      const res = await fetch(`${t.url}/api/alert-configs`, {
        method: 'OPTIONS',
        headers: {
          Origin: 'https://evil.example.com',
          'Access-Control-Request-Method': 'POST',
          'Access-Control-Request-Headers': 'content-type',
        },
      });
      expect(res.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('returns the CORS header on the actual write', async () => {
      const res = await request('POST', '', gearboxError, { Origin: ORIGIN });
      expect(res.status).toBe(201);
      expect(res.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    });
  });

  it('pushes alert-config.changed over SSE after each committed write', async () => {
    const sse = await openSse(`${t.url}/api/events`);
    try {
      const created = await create();
      const createdEvent = await sse.nextEvent(ALERT_CONFIG_CHANGED);
      expect(createdEvent.id).toMatch(/^\d+-\d+$/);
      expect(JSON.parse(createdEvent.data)).toEqual({
        action: 'created',
        id: created.id,
        config: created,
      });
      // The event is published only after the row is visible to other readers.
      expect(await t.prisma.alertConfig.count()).toBe(1);

      await request('PATCH', `/${created.id}`, { valueMetric: 100 });
      expect(
        JSON.parse((await sse.nextEvent(ALERT_CONFIG_CHANGED)).data),
      ).toMatchObject({
        action: 'updated',
        config: { valueMetric: 100 },
      });

      await request('DELETE', `/${created.id}`);
      expect(
        JSON.parse((await sse.nextEvent(ALERT_CONFIG_CHANGED)).data),
      ).toEqual({
        action: 'deleted',
        id: created.id,
      });

      // Failed writes publish nothing: the next event is the one after them.
      await request('POST', '', { ...gearboxError, alertLevel: 'nope' });
      await request('DELETE', `/${UNKNOWN_ID}`);
      const next = await create({ ...gearboxError, alertLevel: 'info' });
      expect(
        JSON.parse((await sse.nextEvent(ALERT_CONFIG_CHANGED)).data).id,
      ).toBe(next.id);
    } finally {
      sse.close();
    }
  });
});
