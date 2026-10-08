import { seedFromCsv } from '@nextera/shared';
import { SEED_DATA_DIR } from '@nextera/testing/seed-data';
import { createTestApp, type TestApp } from './helpers.js';

/** GET /api/reports/telemetry on the CSV seed (TURB001 on FARM01, TURB002 on FARM02, 2 days). */
describe('Reports API (e2e, CSV seed data)', () => {
  let t: TestApp;
  let gearboxError: string;

  const get = (query: string) =>
    fetch(`${t.url}/api/reports/telemetry${query}`, {
      headers: t.auth('owner'), // reports need owner or above
    });
  const TWO_DAYS = 'from=2026-01-01T00:00:00Z&to=2026-01-03T00:00:00Z';

  beforeAll(async () => {
    t = await createTestApp();
    await t.prisma
      .$executeRaw`TRUNCATE TABLE telemetry_alerts, alerts_config, telemetry, turbines, farms`;
    await seedFromCsv(t.prisma, SEED_DATA_DIR);
    gearboxError = (
      await t.prisma.alertConfig.create({
        data: {
          measurementMetric: 'gearboxTempC',
          comparison: 'above',
          valueMetric: 120,
          alertLevel: 'error',
        },
      })
    ).id;
    // What ingestion stores for TURB002's frozen gearbox (126.5 °C at 03:20).
    const hot = await t.prisma.telemetry.findUniqueOrThrow({
      where: {
        turbineId_timestamp: {
          turbineId: 'TURB002',
          timestamp: new Date('2026-01-02T03:20:00Z'),
        },
      },
    });
    await t.prisma.telemetryAlert.create({
      data: { telemetryId: hot.id, alertId: gearboxError },
    });
  });

  afterAll(async () => {
    await t.prisma.$executeRaw`TRUNCATE TABLE telemetry_alerts, alerts_config`;
    await t.app.close();
  });

  it('reports a turbine: every reading in [from, to), oldest first, with its alerts', async () => {
    const res = await get(`?turbineId=TURB002&${TWO_DAYS}`);
    expect(res.status).toBe(200);
    const report = (await res.json()) as {
      scope: unknown;
      from: string;
      to: string;
      readings: {
        turbineId: string;
        timestamp: string;
        alerts: { id: string }[];
      }[];
    };

    expect(report.scope).toEqual({
      kind: 'turbine',
      id: 'TURB002',
      name: 'High Plains',
      farmId: 'FARM02',
    });
    expect([report.from, report.to]).toEqual([
      '2026-01-01T00:00:00.000Z',
      '2026-01-03T00:00:00.000Z',
    ]);
    const count = await t.prisma.telemetry.count({
      where: { turbineId: 'TURB002' },
    });
    expect(report.readings).toHaveLength(count); // the seed lies within the two days
    expect(report.readings.every((r) => r.turbineId === 'TURB002')).toBe(true);
    const times = report.readings.map((r) => r.timestamp);
    expect([...times].sort()).toEqual(times); // oldest first
    const flagged = report.readings.filter((r) => r.alerts.length);
    expect(
      flagged.map((r) => [r.timestamp, r.alerts.map((a) => a.id)]),
    ).toEqual([['2026-01-02T03:20:00.000Z', [gearboxError]]]);
  });

  it('reports a farm: the readings of its turbines only', async () => {
    const report = await (await get(`?farmId=FARM01&${TWO_DAYS}`)).json();
    expect(report.scope).toEqual({
      kind: 'farm',
      id: 'FARM01',
      name: 'Prairie Ridge',
      farmId: 'FARM01',
    });
    expect(
      new Set(report.readings.map((r: { turbineId: string }) => r.turbineId)),
    ).toEqual(new Set(['TURB001']));
  });

  it('uses the measurement time, with to exclusive', async () => {
    const report = await (
      await get(
        '?turbineId=TURB002&from=2026-01-02T03:20:00Z&to=2026-01-02T03:30:00Z',
      )
    ).json();
    expect(
      report.readings.map((r: { timestamp: string }) => r.timestamp),
    ).toEqual(['2026-01-02T03:20:00.000Z', '2026-01-02T03:25:00.000Z']);
  });

  it.each([
    [`?${TWO_DAYS}`, 400, 'Provide exactly one of farmId or turbineId'],
    [
      `?farmId=FARM01&turbineId=TURB001&${TWO_DAYS}`,
      400,
      'Provide exactly one of farmId or turbineId',
    ],
    [
      '?turbineId=TURB002',
      400,
      'from must be an ISO 8601 date-time with a time zone (e.g. 2026-01-01T00:00:00Z)',
    ],
    [
      '?turbineId=TURB002&from=2026-W01-4&to=2026-01-03T00:00:00Z',
      400,
      'from must be an ISO 8601 date-time with a time zone (e.g. 2026-01-01T00:00:00Z)',
    ],
    [
      '?turbineId=TURB002&from=2026-01-03T00:00:00Z&to=2026-01-01T00:00:00Z',
      400,
      'to must be after from',
    ],
    [
      '?turbineId=TURB002&from=2026-01-01T00:00:00Z&to=2026-03-01T00:00:00Z',
      400,
      'The range may span at most 31 days',
    ],
    [`?turbineId=TURB999&${TWO_DAYS}`, 404, 'Turbine TURB999 not found'],
    [`?farmId=FARM99&${TWO_DAYS}`, 404, 'Farm FARM99 not found'],
  ])('rejects %s with %i', async (query, status, message) => {
    const res = await get(query);
    expect(res.status).toBe(status);
    expect(JSON.stringify(await res.json())).toContain(message);
  });

  it('allows the Angular origin (CORS)', async () => {
    const res = await fetch(
      `${t.url}/api/reports/telemetry?turbineId=TURB002&${TWO_DAYS}`,
      { headers: { Origin: 'http://localhost:4200', ...t.auth('owner') } },
    );
    expect(res.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:4200',
    );
  });
});
