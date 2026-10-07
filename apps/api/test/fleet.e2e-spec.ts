import { seedFromCsv } from '@nextera/shared';
import { SEED_DATA_DIR } from '@nextera/testing/seed-data';
import { createTestApp, type TestApp } from './helpers.js';

/** Runs against the provided CSV dataset (10 farms, 2 turbines, 2 days of telemetry). */
describe('Fleet API (e2e, CSV seed data)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await t.prisma
      .$executeRaw`TRUNCATE TABLE telemetry_alerts, telemetry, turbines, farms`;
    await seedFromCsv(t.prisma, SEED_DATA_DIR);
  });

  afterAll(async () => {
    await t.app.close();
  });

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`${t.url}/api${path}`, {
      headers: { ...t.auth('viewer'), ...headers },
    });

  describe('GET /api/farms', () => {
    it('returns every farm with its turbines and their latest reading', async () => {
      const farms = await (await get('/farms')).json();

      expect(farms).toHaveLength(10);
      expect(
        farms.filter((f: { turbines: [] }) => f.turbines.length),
      ).toHaveLength(2);
      expect(farms[0]).toMatchObject({
        id: 'FARM01',
        name: 'Prairie Ridge',
        latitude: 41.25,
        longitude: -96.53,
        turbines: [
          {
            id: 'TURB001', // the business key, not the internal UUID
            farmId: 'FARM01',
            commissioned: false, // turbines.csv has no commissioned column
            latest: {
              turbineId: 'TURB001',
              farmId: 'FARM01',
              timestamp: '2026-01-02T23:55:00.000Z', // last reading in telemetry.csv
              receivedAt: '2026-01-03T00:13:00.000Z',
              powerOutputKw: 1960.5,
            },
          },
        ],
      });
    });

    it('lists farms without turbines with an empty list', async () => {
      const farms = await (await get('/farms')).json();
      expect(
        farms.find((f: { id: string }) => f.id === 'FARM10'),
      ).toMatchObject({
        name: 'Coastal Breeze',
        turbines: [],
      });
    });

    it('exposes commissioned, never the internal UUID, and keeps both across re-seeding', async () => {
      const before = await t.prisma.turbine.findMany({
        orderBy: { turbineId: 'asc' },
      });
      expect(before.map((b) => b.id)).toEqual([
        expect.stringMatching(/^[0-9a-f-]{36}$/),
        expect.stringMatching(/^[0-9a-f-]{36}$/),
      ]);
      await t.prisma.turbine.update({
        where: { turbineId: 'TURB002' },
        data: { commissioned: true },
      });

      try {
        // Idempotent: upserts by turbine_id, so the UUIDs and the flag survive a re-seed.
        await seedFromCsv(t.prisma, SEED_DATA_DIR);
        const after = await t.prisma.turbine.findMany({
          orderBy: { turbineId: 'asc' },
        });
        expect(after.map((a) => [a.turbineId, a.id, a.commissioned])).toEqual([
          ['TURB001', before[0].id, false],
          ['TURB002', before[1].id, true],
        ]);

        const farms = await (await get('/farms')).json();
        const turbine = farms.find((f: { id: string }) => f.id === 'FARM02')
          .turbines[0];
        expect(Object.keys(turbine).sort()).toEqual([
          'commissioned',
          'farmId',
          'id',
          'latest',
          'latitude',
          'longitude',
        ]);
        expect(turbine).toMatchObject({ id: 'TURB002', commissioned: true });
        expect(JSON.stringify(farms)).not.toContain(before[1].id);
      } finally {
        await t.prisma.turbine.update({
          where: { turbineId: 'TURB002' },
          data: { commissioned: false },
        });
      }
    });

    it('picks the latest reading by measurement time, not arrival time (late data)', async () => {
      // A reading for an older instant arriving now must not become "latest".
      await t.prisma.telemetry.create({
        data: {
          turbineId: 'TURB002',
          farmId: 'FARM02',
          timestamp: new Date('2026-01-02T23:50:00Z'), // gap in the CSV, filled late
          receivedAt: new Date(),
          powerOutputKw: 1,
          windSpeedMs: 1,
          rotorRpm: 1,
          bladePitchDeg: 1,
          gearboxTempC: 1,
        },
      });

      const farms = await (await get('/farms')).json();
      const turbine = farms.find((f: { id: string }) => f.id === 'FARM02')
        .turbines[0];
      expect(turbine.latest.timestamp).toBe('2026-01-02T23:55:00.000Z');
    });
  });

  describe('GET /api/turbines/:id/telemetry', () => {
    it('returns readings newest first, limited to 24h (288) by default', async () => {
      const readings = await (await get('/turbines/TURB001/telemetry')).json();

      expect(readings).toHaveLength(288);
      expect(readings[0].timestamp).toBe('2026-01-02T23:55:00.000Z');
      const times = readings.map((r: { timestamp: string }) => r.timestamp);
      expect([...times].sort().reverse()).toEqual(times);
    });

    it('filters by [from, to) and shows the frozen gearbox anomaly in TURB002', async () => {
      const readings = await (
        await get(
          '/turbines/TURB002/telemetry?from=2026-01-02T03:20:00Z&to=2026-01-02T03:35:00Z',
        )
      ).json();

      expect(
        readings.map((r: { timestamp: string; gearboxTempC: number }) => [
          r.timestamp,
          r.gearboxTempC,
        ]),
      ).toEqual([
        ['2026-01-02T03:30:00.000Z', 126.5],
        ['2026-01-02T03:25:00.000Z', 126.5],
        ['2026-01-02T03:20:00.000Z', 126.5],
      ]);
    });

    it('joins in the alert rules each reading triggered (telemetry_alerts → alerts_config)', async () => {
      const rule = await t.prisma.alertConfig.create({
        data: {
          measurementMetric: 'gearboxTempC',
          comparison: 'above',
          valueMetric: 120,
          alertLevel: 'error',
        },
      });
      const hot = await t.prisma.telemetry.findUniqueOrThrow({
        where: {
          turbineId_timestamp: {
            turbineId: 'TURB002',
            timestamp: new Date('2026-01-02T03:25:00Z'),
          },
        },
      });
      // What ingestion stores for a reading that triggered the rule.
      await t.prisma.telemetryAlert.create({
        data: { telemetryId: hot.id, alertId: rule.id },
      });

      try {
        const readings = await (
          await get(
            '/turbines/TURB002/telemetry?from=2026-01-02T03:20:00Z&to=2026-01-02T03:35:00Z',
          )
        ).json();
        expect(
          readings.map((r: { timestamp: string; alerts: unknown[] }) => [
            r.timestamp,
            r.alerts,
          ]),
        ).toEqual([
          ['2026-01-02T03:30:00.000Z', []],
          [
            '2026-01-02T03:25:00.000Z',
            [
              {
                id: rule.id,
                measurementMetric: 'gearboxTempC',
                comparison: 'above',
                valueMetric: 120,
                alertLevel: 'error',
                enabled: true,
              },
            ],
          ],
          ['2026-01-02T03:20:00.000Z', []],
        ]);

        // A join, not a snapshot: the reading shows the rule as it is now.
        await t.prisma.alertConfig.update({
          where: { id: rule.id },
          data: { valueMetric: 110 },
        });
        const [, edited] = await (
          await get(
            '/turbines/TURB002/telemetry?from=2026-01-02T03:20:00Z&to=2026-01-02T03:35:00Z',
          )
        ).json();
        expect(edited.alerts[0].valueMetric).toBe(110);
      } finally {
        await t.prisma
          .$executeRaw`TRUNCATE TABLE telemetry_alerts, alerts_config`;
      }
    });

    it('includes the triggered rules on each turbine’s latest reading in GET /api/farms', async () => {
      const rule = await t.prisma.alertConfig.create({
        data: {
          measurementMetric: 'powerOutputKw',
          comparison: 'above',
          valueMetric: 1000,
          alertLevel: 'info',
        },
      });
      const latest = await t.prisma.telemetry.findFirstOrThrow({
        where: { turbineId: 'TURB001' },
        orderBy: { timestamp: 'desc' },
      });
      await t.prisma.telemetryAlert.create({
        data: { telemetryId: latest.id, alertId: rule.id },
      });

      try {
        const farms = await (await get('/farms')).json();
        const turbines = farms.flatMap(
          (f: { turbines: { id: string; latest: { alerts: unknown[] } }[] }) =>
            f.turbines,
        );
        expect(
          turbines.map(
            (x: { id: string; latest: { alerts: { id: string }[] } }) => [
              x.id,
              x.latest.alerts.map((a) => a.id),
            ],
          ),
        ).toEqual([
          ['TURB001', [rule.id]],
          ['TURB002', []],
        ]);
      } finally {
        await t.prisma
          .$executeRaw`TRUNCATE TABLE telemetry_alerts, alerts_config`;
      }
    });

    it('honours limit', async () => {
      const readings = await (
        await get('/turbines/TURB001/telemetry?limit=3')
      ).json();
      expect(readings).toHaveLength(3);
    });

    it('returns 404 for an unknown turbine', async () => {
      expect((await get('/turbines/TURB999/telemetry')).status).toBe(404);
    });

    it('rejects invalid query parameters with 400', async () => {
      const res = await get(
        '/turbines/TURB001/telemetry?limit=0&from=yesterday&x=1',
      );

      expect(res.status).toBe(400);
      expect((await res.json()).message).toEqual(
        expect.arrayContaining([
          'property x should not exist',
          'from must be a valid ISO 8601 date string',
          'limit must not be less than 1',
        ]),
      );
    });
  });

  describe('GET /api/turbines/:id/telemetry/stats', () => {
    const METRICS = [
      'powerOutputKw',
      'windSpeedMs',
      'rotorRpm',
      'bladePitchDeg',
      'gearboxTempC',
    ] as const;
    type Reading = Record<(typeof METRICS)[number], number> & {
      timestamp: string;
    };

    const median = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = sorted.length / 2;
      return Number.isInteger(mid)
        ? (sorted[mid - 1] + sorted[mid]) / 2 // even count: interpolated
        : sorted[Math.floor(mid)];
    };

    it.each([
      ['the default 24h (288 readings)', ''],
      ['a limit', '?limit=7'], // even count: interpolated median
      [
        'a time range',
        '?from=2026-01-01T12:00:00Z&to=2026-01-01T15:00:00Z', // TURB001's stop at 13:40–13:50
      ],
      [
        'a time range and a limit',
        '?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z&limit=101',
      ],
    ])(
      'covers exactly the readings the telemetry endpoint returns for %s',
      async (_, query) => {
        const readings: Reading[] = await (
          await get(`/turbines/TURB001/telemetry${query}`)
        ).json();
        const res = await get(`/turbines/TURB001/telemetry/stats${query}`);
        expect(res.status).toBe(200);
        const stats = await res.json();

        expect(readings.length).toBeGreaterThan(0);
        expect(stats).toMatchObject({
          turbineId: 'TURB001',
          count: readings.length,
          from: readings.at(-1)!.timestamp,
          to: readings[0].timestamp,
        });
        for (const metric of METRICS) {
          const values = readings.map((r) => r[metric]);
          const s = stats.metrics[metric];
          // Plain JSON numbers (not numeric strings or bigints from Postgres).
          for (const key of ['median', 'high', 'low']) {
            expect(typeof s[key]).toBe('number');
          }
          expect(s.median).toBeCloseTo(median(values), 6);
          expect(s.high).toBe(Math.max(...values));
          expect(s.low).toBe(Math.min(...values));
        }
      },
    );

    it('reports the frozen gearbox anomaly in TURB002 (03:20–03:30 at 126.5 °C)', async () => {
      const stats = await (
        await get(
          '/turbines/TURB002/telemetry/stats?from=2026-01-02T03:20:00Z&to=2026-01-02T03:35:00Z',
        )
      ).json();

      expect(stats).toMatchObject({
        count: 3,
        from: '2026-01-02T03:20:00.000Z',
        to: '2026-01-02T03:30:00.000Z',
        metrics: {
          gearboxTempC: { median: 126.5, high: 126.5, low: 126.5 },
        },
      });
    });

    it('returns count 0 and null stats for an empty window', async () => {
      const res = await get(
        '/turbines/TURB001/telemetry/stats?from=2030-01-01T00:00:00Z',
      );

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        turbineId: 'TURB001',
        from: null,
        to: null,
        count: 0,
        metrics: {
          powerOutputKw: null,
          windSpeedMs: null,
          rotorRpm: null,
          bladePitchDeg: null,
          gearboxTempC: null,
        },
      });
    });

    it('returns 404 for an unknown turbine', async () => {
      expect((await get('/turbines/TURB999/telemetry/stats')).status).toBe(404);
    });

    it('validates the query like the telemetry endpoint (400)', async () => {
      const res = await get(
        '/turbines/TURB001/telemetry/stats?limit=2017&to=soon&x=1',
      );

      expect(res.status).toBe(400);
      expect((await res.json()).message).toEqual(
        expect.arrayContaining([
          'property x should not exist',
          'to must be a valid ISO 8601 date string',
          'limit must not be greater than 2016',
        ]),
      );
    });

    it('allows the Angular origin (CORS)', async () => {
      const res = await get('/turbines/TURB001/telemetry/stats', {
        Origin: 'http://localhost:4200',
      });
      expect(res.headers.get('access-control-allow-origin')).toBe(
        'http://localhost:4200',
      );
    });
  });

  describe('cross-cutting', () => {
    it('allows the Angular origin (CORS) and refuses others', async () => {
      const allowed = await get('/farms', { Origin: 'http://localhost:4200' });
      expect(allowed.headers.get('access-control-allow-origin')).toBe(
        'http://localhost:4200',
      );

      const refused = await get('/farms', {
        Origin: 'https://evil.example.com',
      });
      expect(refused.headers.get('access-control-allow-origin')).toBeNull();
    });

    it('reports liveness and readiness', async () => {
      expect(await (await get('/health/live')).json()).toEqual({
        status: 'ok',
      });
      const ready = await get('/health/ready');
      expect(ready.status).toBe(200);
      expect((await ready.json()).details).toMatchObject({
        database: { status: 'up' },
        redis: { status: 'up' },
      });
    });
  });
});
