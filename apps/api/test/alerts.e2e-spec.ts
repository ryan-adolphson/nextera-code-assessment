import { seedFromCsv } from '@nextera/shared';
import { SEED_DATA_DIR } from '@nextera/testing/seed-data';
import { createTestApp, type TestApp } from './helpers.js';

/** GET /api/alerts on the CSV seed (2 turbines, 2 days of telemetry) with stored alert links. */
describe('Alerts API (e2e, CSV seed data)', () => {
  let t: TestApp;
  let gearboxError: string;
  let gearboxWarn: string;
  let lowPower: string;

  const readingAt = async (turbineId: string, iso: string) =>
    (
      await t.prisma.telemetry.findUniqueOrThrow({
        where: { turbineId_timestamp: { turbineId, timestamp: new Date(iso) } },
      })
    ).id;
  /** What ingestion stores for a reading that triggered `alertIds`. */
  const flag = async (
    turbineId: string,
    iso: string,
    ...alertIds: string[]
  ) => {
    const telemetryId = await readingAt(turbineId, iso);
    await t.prisma.telemetryAlert.createMany({
      data: alertIds.map((alertId) => ({ telemetryId, alertId })),
    });
  };
  const get = (query: string) => fetch(`${t.url}/api/alerts${query}`);

  beforeAll(async () => {
    t = await createTestApp();
    await t.prisma
      .$executeRaw`TRUNCATE TABLE telemetry_alerts, alerts_config, telemetry, turbines, farms`;
    await seedFromCsv(t.prisma, SEED_DATA_DIR);
    const rule = (data: object) =>
      t.prisma.alertConfig.create({ data: data as never }).then((r) => r.id);
    gearboxError = await rule({
      measurementMetric: 'gearboxTempC',
      comparison: 'above',
      valueMetric: 120,
      alertLevel: 'error',
    });
    gearboxWarn = await rule({
      measurementMetric: 'gearboxTempC',
      comparison: 'above',
      valueMetric: 90,
      alertLevel: 'warn',
      enabled: false, // disabled since: still shown on the readings it flagged
    });
    lowPower = await rule({
      measurementMetric: 'powerOutputKw',
      comparison: 'below',
      valueMetric: 100,
      alertLevel: 'info',
    });
    // TURB002's frozen gearbox (126.5 °C at 03:20–03:30) and one low-power TURB001 reading.
    for (const iso of [
      '2026-01-02T03:20:00Z',
      '2026-01-02T03:25:00Z',
      '2026-01-02T03:30:00Z',
    ]) {
      await flag('TURB002', iso, gearboxWarn, gearboxError);
    }
    await flag('TURB001', '2026-01-01T13:40:00Z', lowPower);
  });

  afterAll(async () => {
    await t.prisma.$executeRaw`TRUNCATE TABLE telemetry_alerts, alerts_config`;
    await t.app.close();
  });

  it('returns the flagged readings in [from, to), grouped by turbine, newest first, with their rules', async () => {
    const res = await get('?from=2026-01-01T00:00:00Z&to=2026-01-03T00:00:00Z');
    expect(res.status).toBe(200);
    const readings = (await res.json()) as {
      turbineId: string;
      timestamp: string;
      gearboxTempC: number;
      alerts: { id: string; alertLevel: string; enabled: boolean }[];
    }[];

    expect(readings.map((r) => [r.turbineId, r.timestamp])).toEqual([
      ['TURB001', '2026-01-01T13:40:00.000Z'],
      ['TURB002', '2026-01-02T03:30:00.000Z'],
      ['TURB002', '2026-01-02T03:25:00.000Z'],
      ['TURB002', '2026-01-02T03:20:00.000Z'],
    ]);
    expect(readings[1].gearboxTempC).toBe(126.5);
    // Joined from alerts_config, worst level first; the disabled rule is still listed.
    expect(
      readings[1].alerts.map((a) => [a.id, a.alertLevel, a.enabled]),
    ).toEqual([
      [gearboxError, 'error', true],
      [gearboxWarn, 'warn', false],
    ]);
    expect(readings[0].alerts.map((a) => a.id)).toEqual([lowPower]);
  });

  it('uses the measurement time, with to exclusive', async () => {
    const readings = await (
      await get('?from=2026-01-02T03:25:00Z&to=2026-01-02T03:30:00Z')
    ).json();
    expect(readings.map((r: { timestamp: string }) => r.timestamp)).toEqual([
      '2026-01-02T03:25:00.000Z',
    ]);
  });

  it('returns an empty list when nothing was flagged in the range', async () => {
    const res = await get('?from=2026-01-05T00:00:00Z&to=2026-01-06T00:00:00Z');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it.each([
    ['', 'from must be an ISO 8601 date'],
    ['?from=2026-01-02T00:00:00Z', 'to must be an ISO 8601 date'],
    [
      '?from=yesterday&to=2026-01-02T00:00:00Z',
      'from must be an ISO 8601 date',
    ],
    [
      '?from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z',
      'to must be after from',
    ],
    [
      '?from=2026-01-01T00:00:00Z&to=2026-03-01T00:00:00Z',
      'The range may span at most 31 days',
    ],
    [
      '?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z&limit=5',
      'property limit should not exist',
    ],
  ])('rejects %s with 400', async (query, message) => {
    const res = await get(query);
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain(message);
  });

  it('allows the Angular origin (CORS)', async () => {
    const res = await fetch(
      `${t.url}/api/alerts?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z`,
      { headers: { Origin: 'http://localhost:4200' } },
    );
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:4200',
    );
  });
});
