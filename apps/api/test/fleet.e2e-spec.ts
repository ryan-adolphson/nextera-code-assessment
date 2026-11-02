import {
  runFarmRollup,
  seedFromCsv,
  upsertFarmWeather,
  type WeatherBucketRow,
} from '@nextera/shared';
import { SEED_DATA_DIR } from '@nextera/testing/seed-data';
import { createTestApp, type TestApp } from './helpers.js';

/** Runs against the provided CSV dataset (10 farms, 2 turbines, 2 days of telemetry). */
describe('Fleet API (e2e, CSV seed data)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
    await t.prisma
      .$executeRaw`TRUNCATE TABLE telemetry_alerts, telemetry, turbines, farm_weather, farm_telemetry_rollups, farms`;
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

  describe('weather: GET /api/farms/:farmId/weather and /api/turbines/:id/weather', () => {
    const DAYS = 'from=2026-01-01T00:00:00Z&to=2026-01-03T00:00:00Z';
    const HALF_HOUR_MS = 30 * 60 * 1000;
    const bucket = (at: string | number, samples = 2): WeatherBucketRow => ({
      time: new Date(at),
      samples,
      windSpeed10mMs: 5,
      windSpeed80mMs: 10,
      windDirection10mDeg: 180,
      windDirection80mDeg: 180,
      windGusts10mMs: 12,
      temperature2mC: 2,
      relativeHumidity2mPct: 80,
      surfacePressureHpa: 990,
      precipitationMm: 0.5,
      cloudCoverPct: null,
    });
    /** Every 30-minute bucket in [from, to). */
    const buckets = (from: string, to: string) =>
      Array.from(
        { length: (Date.parse(to) - Date.parse(from)) / HALF_HOUR_MS },
        (_, i) => bucket(Date.parse(from) + i * HALF_HOUR_MS),
      );

    beforeAll(async () => {
      await t.prisma.$executeRaw`TRUNCATE TABLE farm_weather`;
      await upsertFarmWeather(t.prisma, 'FARM01', [
        bucket('2026-01-01T00:00:00Z', 1),
        bucket('2026-01-01T00:30:00Z'),
        bucket('2026-01-02T00:00:00Z'),
        bucket('2026-01-03T00:00:00Z'), // outside [from, to)
        // America/Chicago falls back on 2026-11-01 (a 25-hour local day).
        ...buckets('2026-10-31T00:00:00Z', '2026-11-03T00:00:00Z'),
      ]);
    });

    it('returns 30-minute points by default (viewer)', async () => {
      const res = await get(`/farms/FARM01/weather?${DAYS}`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        farmId: 'FARM01',
        interval: '30min',
        timeZone: 'UTC',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-03T00:00:00.000Z',
      });
      expect(body).not.toHaveProperty('turbineId');
      expect(body.points.map((p: { time: string }) => p.time)).toEqual([
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:30:00.000Z',
        '2026-01-02T00:00:00.000Z',
      ]);
      expect(body.points[0]).toEqual({
        time: '2026-01-01T00:00:00.000Z',
        samples: 1,
        windSpeed10mMs: 5,
        windSpeed80mMs: 10,
        windDirection10mDeg: 180,
        windDirection80mDeg: 180,
        windGusts10mMs: 12,
        temperature2mC: 2,
        relativeHumidity2mPct: 80,
        surfacePressureHpa: 990,
        precipitationMm: 0.5,
        cloudCoverPct: null,
      });
    });

    it('returns UTC days with interval=daily', async () => {
      const res = await get(`/farms/FARM01/weather?${DAYS}&interval=daily`);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({ interval: 'daily', timeZone: 'UTC' });
      expect(body.points).toEqual([
        {
          date: '2026-01-01',
          samples: 2,
          windSpeed10mMeanMs: 5,
          windSpeed10mMaxMs: 5,
          windSpeed80mMeanMs: 10,
          windSpeed80mMaxMs: 10,
          windDirection80mDeg: 180,
          windGusts10mMaxMs: 12,
          temperature2mMinC: 2,
          temperature2mMaxC: 2,
          temperature2mMeanC: 2,
          relativeHumidity2mMeanPct: 80,
          surfacePressureMeanHpa: 990,
          precipitationSumMm: 1,
          cloudCoverMeanPct: null,
        },
        expect.objectContaining({ date: '2026-01-02', samples: 1 }),
      ]);
    });

    describe('GET /api/turbines/:id/weather', () => {
      it("returns its farm's 30-minute points with the turbine id", async () => {
        const res = await get(`/turbines/TURB001/weather?${DAYS}`);
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(Object.keys(body)).toEqual([
          'farmId',
          'turbineId',
          'from',
          'to',
          'interval',
          'timeZone',
          'points',
        ]);
        expect(body).toMatchObject({
          farmId: 'FARM01',
          turbineId: 'TURB001',
          interval: '30min',
          timeZone: 'UTC',
        });
        expect(body.points).toHaveLength(3);
      });

      it('returns daily points', async () => {
        const res = await get(
          `/turbines/TURB001/weather?${DAYS}&interval=daily`,
        );
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body).toMatchObject({ turbineId: 'TURB001', interval: 'daily' });
        expect(
          body.points.map((p: { date: string; samples: number }) => [
            p.date,
            p.samples,
          ]),
        ).toEqual([
          ['2026-01-01', 2],
          ['2026-01-02', 1],
        ]);
      });

      it('returns no points for a turbine whose farm has no weather', async () => {
        const body = await (
          await get(`/turbines/TURB002/weather?${DAYS}`)
        ).json();
        expect(body).toMatchObject({ farmId: 'FARM02', points: [] });
      });

      it('returns 404 for an unknown turbine', async () => {
        const res = await get(`/turbines/TURB999/weather?${DAYS}`);
        expect(res.status).toBe(404);
        expect(await res.json()).toMatchObject({
          message: 'Turbine TURB999 not found',
        });
      });

      it('returns 401 without a token', async () => {
        const res = await fetch(
          `${t.url}/api/turbines/TURB001/weather?${DAYS}`,
        );
        expect(res.status).toBe(401);
      });
    });

    describe('timeZone', () => {
      const days = async (path: string) => {
        const res = await get(path);
        expect(res.status).toBe(200);
        const body = await res.json();
        return {
          timeZone: body.timeZone,
          days: body.points.map((p: { date: string; samples: number }) => [
            p.date,
            p.samples,
          ]),
        };
      };
      // Local midnight 2026-10-31 (CDT, −5) to local midnight 2026-11-02 (CST, −6).
      const LOCAL = 'from=2026-10-31T05:00:00Z&to=2026-11-02T06:00:00Z';

      it('buckets daily points by local day, 50 buckets on the fall-back day', async () => {
        expect(
          await days(
            `/turbines/TURB001/weather?${LOCAL}&interval=daily&timeZone=America/Chicago`,
          ),
        ).toEqual({
          timeZone: 'America/Chicago',
          days: [
            ['2026-10-31', 48],
            ['2026-11-01', 50],
          ],
        });
      });

      it('gives UTC days for the same range without it', async () => {
        expect(
          await days(`/farms/FARM01/weather?${LOCAL}&interval=daily`),
        ).toEqual({
          timeZone: 'UTC',
          days: [
            ['2026-10-31', 38],
            ['2026-11-01', 48],
            ['2026-11-02', 12],
          ],
        });
      });

      it('leaves 30-minute times as UTC instants and echoes the zone', async () => {
        const body = await (
          await get(
            '/farms/FARM01/weather?from=2026-11-01T06:00:00Z&to=2026-11-01T07:00:00Z&timeZone=America/Chicago',
          )
        ).json();
        expect(body.timeZone).toBe('America/Chicago');
        expect(body.points.map((p: { time: string }) => p.time)).toEqual([
          '2026-11-01T06:00:00.000Z',
          '2026-11-01T06:30:00.000Z',
        ]);
      });

      it.each([
        ['an unknown zone', 'Mars/Olympus'],
        ['a POSIX spec', 'UTC%2B6'],
        ['an empty zone', ''],
        ['an injection attempt', "UTC'%3B%20DROP%20TABLE%20farms%3B--"],
      ])('rejects %s with 400 on both endpoints', async (_case, zone) => {
        for (const path of ['/farms/FARM01', '/turbines/TURB001']) {
          const res = await get(
            `${path}/weather?${DAYS}&interval=daily&timeZone=${zone}`,
          );
          expect(res.status).toBe(400);
          expect((await res.json()).message).toBe(
            'timeZone must be an IANA time zone name, e.g. "America/Chicago" (default "UTC")',
          );
        }
      });
    });

    it.each([
      ['the removed hourly interval', `${DAYS}&interval=hourly`],
      ['an unknown interval', `${DAYS}&interval=weekly`],
      ['a missing from', 'to=2026-01-03T00:00:00Z'],
      [
        'a zone-less timestamp',
        'from=2026-01-01T00:00:00&to=2026-01-03T00:00:00Z',
      ],
      ['a reversed range', 'from=2026-01-03T00:00:00Z&to=2026-01-01T00:00:00Z'],
      [
        'a range over 31 days',
        'from=2026-01-01T00:00:00Z&to=2026-03-01T00:00:00Z',
      ],
      ['an unknown parameter', `${DAYS}&limit=5`],
      ['a repeated timeZone', `${DAYS}&timeZone=UTC&timeZone=UTC`],
    ])('rejects %s with 400 (farm and turbine)', async (_case, query) => {
      for (const path of ['/farms/FARM01', '/turbines/TURB001']) {
        const res = await get(`${path}/weather?${query}`);
        expect(res.status).toBe(400);
      }
    });

    it('returns 404 for an unknown farm', async () => {
      const res = await get(`/farms/FARM99/weather?${DAYS}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({
        message: 'Farm FARM99 not found',
      });
    });

    it('returns 401 without a token', async () => {
      const res = await fetch(`${t.url}/api/farms/FARM01/weather?${DAYS}`);
      expect(res.status).toBe(401);
    });
  });

  describe('GET /api/farms/:farmId/telemetry/daily', () => {
    const NOW = new Date('2026-01-03T00:00:00Z');
    const DAYS = 'from=2026-01-01T00:00:00Z&to=2026-01-03T00:00:00Z';
    const path = `/farms/FARM01/telemetry/daily?${DAYS}`;
    // fetch() adds `Cache-Control: no-cache` to a request with If-None-Match (Fetch spec, cache
    // mode no-store), and Express rightly answers that with a full 200; a browser revalidating
    // its own cached copy (or curl) doesn't, so send what it would.
    const revalidate = (etag: string) => ({
      'If-None-Match': etag,
      'Cache-Control': 'max-age=0',
    });

    beforeAll(async () => {
      await t.prisma
        .$executeRaw`TRUNCATE TABLE farm_telemetry_rollups, farm_rollup_state, farm_rollup_dirty`;
      await runFarmRollup(t.prisma, { mode: { kind: 'full' }, now: NOW });
    });

    it('returns daily candles of the farm series from the rollups (viewer)', async () => {
      const res = await get(path);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(Object.keys(body)).toEqual([
        'farmId',
        'from',
        'to',
        'timeZone',
        'turbineCount',
        'computedAt',
        'days',
      ]);
      expect(body).toMatchObject({
        farmId: 'FARM01',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-03T00:00:00.000Z',
        timeZone: 'UTC',
        turbineCount: 1,
      });
      expect(Date.parse(body.computedAt)).not.toBeNaN();
      expect(body.days.map((d: { date: string }) => d.date)).toEqual([
        '2026-01-01',
        '2026-01-02',
      ]);

      // FARM01 has one turbine (TURB001), so each day is that turbine's own OHLC: check it
      // against the raw readings, computed independently of the rollups.
      const expected = await t.prisma.$queryRaw<
        {
          day: string;
          n: number;
          open: number;
          close: number;
          high: number;
          low: number;
        }[]
      >`
        SELECT to_char(timestamp AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day,
               count(*)::int AS n,
               (array_agg(power_output_kw ORDER BY timestamp))[1] AS open,
               (array_agg(power_output_kw ORDER BY timestamp DESC))[1] AS close,
               max(power_output_kw) AS high, min(power_output_kw) AS low
        FROM telemetry WHERE farm_id = 'FARM01' GROUP BY 1 ORDER BY 1`;
      expect(body.days).toEqual(
        expected.map((e) => ({
          date: e.day,
          turbines: 1,
          readings: e.n,
          powerOutputKw: {
            open: Math.round(e.open * 100) / 100,
            close: Math.round(e.close * 100) / 100,
            high: Math.round(e.high * 100) / 100,
            low: Math.round(e.low * 100) / 100,
          },
          windSpeedMs: expect.any(Object),
          rotorRpm: expect.any(Object),
          bladePitchDeg: expect.any(Object),
          gearboxTempC: expect.any(Object),
        })),
      );
      // The TURB001 stop (0 kW in 15.8 m/s wind on 2026-01-01) is the day's low.
      expect(body.days[0].powerOutputKw.low).toBe(0);
    });

    it('groups local days in timeZone', async () => {
      const res = await get(
        '/farms/FARM01/telemetry/daily?from=2026-01-01T06:00:00Z&to=2026-01-03T06:00:00Z&timeZone=America/Chicago',
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.timeZone).toBe('America/Chicago');
      // 2026-01-01 00:00Z..06:00Z is still 2025-12-31 in Chicago, so it falls outside the range.
      expect(body.days.map((d: { date: string }) => d.date)).toEqual([
        '2026-01-01',
        '2026-01-02',
      ]);
      expect(body.days[1].readings).toBeLessThan(288); // ends at 2026-01-02T23:55Z = 17:55 CST
    });

    it('sends a weak ETag and Cache-Control: private, no-cache, and 304 for If-None-Match', async () => {
      const first = await get(path);
      const etag = first.headers.get('etag');
      expect(etag).toMatch(/^W\/"[A-Za-z0-9_-]{43}"$/);
      expect(first.headers.get('cache-control')).toBe('private, no-cache');
      expect((await get(path)).headers.get('etag')).toBe(etag); // stable

      const notModified = await get(path, revalidate(etag!));
      expect(notModified.status).toBe(304);
      expect(await notModified.text()).toBe('');
      expect(notModified.headers.get('etag')).toBe(etag);
      expect(notModified.headers.get('cache-control')).toBe(
        'private, no-cache',
      );
      // A reload (what fetch sends by default) gets the full body.
      expect((await get(path, { 'If-None-Match': etag! })).status).toBe(200);

      // Another range or zone is another representation.
      const other = await get(
        `/farms/FARM01/telemetry/daily?${DAYS}&timeZone=Asia/Kolkata`,
        revalidate(etag!),
      );
      expect(other.status).toBe(200);
      expect(other.headers.get('etag')).not.toBe(etag);
    });

    it('changes the ETag when a rollup run changes the data', async () => {
      const before = (await get(path)).headers.get('etag')!;
      const reading = await t.prisma.telemetry.create({
        data: {
          turbineId: 'TURB001',
          farmId: 'FARM01',
          timestamp: new Date('2026-01-01T00:02:30Z'), // a late reading
          powerOutputKw: 9999,
          windSpeedMs: 12,
          rotorRpm: 15,
          bladePitchDeg: 2,
          gearboxTempC: 70,
        },
      });
      try {
        await runFarmRollup(t.prisma, { now: NOW });
        const res = await get(path, revalidate(before));
        expect(res.status).toBe(200);
        expect(res.headers.get('etag')).not.toBe(before);
        const body = await res.json();
        expect(body.days[0].powerOutputKw.high).toBe(9999);
      } finally {
        await t.prisma.telemetry.delete({ where: { id: reading.id } });
        await runFarmRollup(t.prisma, { mode: { kind: 'full' }, now: NOW });
      }
    });

    it('returns no days and computedAt null for a farm without readings', async () => {
      const res = await get(`/farms/FARM03/telemetry/daily?${DAYS}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        farmId: 'FARM03',
        turbineCount: 0,
        computedAt: null,
        days: [],
      });
    });

    it('answers 404 for an unknown farm, without cache headers', async () => {
      const res = await get(`/farms/FARM99/telemetry/daily?${DAYS}`);
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({
        message: 'Farm FARM99 not found',
      });
      expect(res.headers.get('cache-control')).not.toBe('private, no-cache');
    });

    it.each([
      ['a missing to', 'from=2026-01-01T00:00:00Z', /to must be/],
      [
        'a reversed range',
        'from=2026-01-03T00:00:00Z&to=2026-01-01T00:00:00Z',
        /to must be after from/,
      ],
      [
        'more than 183 days',
        'from=2026-01-01T00:00:00Z&to=2026-07-04T00:00:00Z',
        /at most 183 days/,
      ],
      ['an unknown zone', `${DAYS}&timeZone=Mars/Olympus`, /IANA time zone/],
      ['a POSIX zone', `${DAYS}&timeZone=UTC%2B6`, /IANA time zone/],
      [
        'a zone-less timestamp',
        'from=2026-01-01T00:00:00&to=2026-01-02T00:00:00Z',
        /from/,
      ],
      [
        'an unknown parameter',
        `${DAYS}&limit=5`,
        /property limit should not exist/,
      ],
    ])('answers 400 for %s', async (_, qs, message) => {
      const res = await get(`/farms/FARM01/telemetry/daily?${qs}`);
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toMatch(message);
    });

    it('answers 401 without a token', async () => {
      const res = await fetch(`${t.url}/api${path}`);
      expect(res.status).toBe(401);
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
          'from must be an ISO 8601 date-time with a time zone (e.g. 2026-01-01T00:00:00Z)',
          'limit must not be less than 1',
        ]),
      );
    });

    // IsISO8601 accepted these, but new Date() makes a week date Invalid Date and a zone-less
    // value server-local time.
    it.each(['/telemetry', '/telemetry/stats'])(
      'rejects a week-date or zone-less bound on %s with 400',
      async (path) => {
        const res = await get(
          `/turbines/TURB001${path}?from=2026-W01-4&to=2026-01-02T00:00:00`,
        );

        expect(res.status).toBe(400);
        expect((await res.json()).message).toEqual([
          'from must be an ISO 8601 date-time with a time zone (e.g. 2026-01-01T00:00:00Z)',
          'to must be an ISO 8601 date-time with a time zone (e.g. 2026-01-01T00:00:00Z)',
        ]);
      },
    );

    it('accepts a future to (whole UTC days end at tomorrow 00:00Z)', async () => {
      const res = await get(
        '/turbines/TURB001/telemetry?from=2026-01-01T00:00:00.000Z&to=2099-01-01T00:00:00.000Z&limit=1',
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toHaveLength(1);
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
          'to must be an ISO 8601 date-time with a time zone (e.g. 2026-01-01T00:00:00Z)',
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
