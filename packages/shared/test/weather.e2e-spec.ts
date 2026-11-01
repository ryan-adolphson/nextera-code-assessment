import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { seedFromCsv } from '../src/seed/seed-from-csv.js';
import type { WeatherBucketRow } from '../src/weather/open-meteo.js';
import {
  syncFarmWeather,
  upsertFarmWeather,
} from '../src/weather/sync-weather.js';
import {
  QueryInputError,
  QueryNotFoundError,
  farmWeather,
  turbineWeather,
} from '../src/wind/queries.js';
import { openMigrationDb, type MigrationDb } from './migration-db.js';

const DATA_DIR = fileURLToPath(new URL('../prisma/data', import.meta.url));
const HISTORICAL = readFileSync(
  new URL(
    '../src/weather/__fixtures__/historical-farm01-2026-01-01.json',
    import.meta.url,
  ),
  'utf8',
);

const HALF_HOUR_MS = 30 * 60 * 1000;

const bucket = (
  at: string | Date,
  values: Partial<WeatherBucketRow> = {},
): WeatherBucketRow => ({
  time: new Date(at),
  samples: 2,
  windSpeed10mMs: 5,
  windSpeed80mMs: 10,
  windDirection10mDeg: 180,
  windDirection80mDeg: 180,
  windGusts10mMs: 12,
  temperature2mC: 2,
  relativeHumidity2mPct: 80,
  surfacePressureHpa: 990,
  precipitationMm: 0,
  cloudCoverPct: 50,
  ...values,
});

/** Every 30-minute bucket in [from, to). */
const buckets = (from: string, to: string): WeatherBucketRow[] => {
  const rows: WeatherBucketRow[] = [];
  for (let t = Date.parse(from); t < Date.parse(to); t += HALF_HOUR_MS) {
    rows.push(bucket(new Date(t)));
  }
  return rows;
};

/** The weather upsert and the farmWeather / turbineWeather reads against a real Postgres. */
describe('farm weather (e2e)', () => {
  let m: MigrationDb;
  let prisma: PrismaClient;

  beforeAll(async () => {
    m = await openMigrationDb('99999999999999_weather');
    await m.migrateAll();
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: m.url }),
    });
    // Farms and turbines (TURB001 on FARM01, TURB002 on FARM02); the telemetry isn't needed but
    // seedFromCsv is the fixture everyone uses.
    await seedFromCsv(prisma, DATA_DIR);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await m?.close();
  });

  beforeEach(async () => {
    await prisma.$executeRaw`TRUNCATE TABLE farm_weather`;
  });

  const stored = () =>
    prisma.farmWeather.findMany({
      where: { farmId: 'FARM01' },
      orderBy: { time: 'asc' },
    });

  describe('upsertFarmWeather', () => {
    it('stores nulls and is idempotent', async () => {
      const rows = [
        bucket('2026-01-01T00:00:00Z', { windSpeed10mMs: null }),
        bucket('2026-01-01T00:30:00Z', { samples: 1 }),
      ];
      expect(await upsertFarmWeather(prisma, 'FARM01', rows)).toBe(2);
      expect(await upsertFarmWeather(prisma, 'FARM01', rows)).toBe(2); // refreshed
      const after = await stored();
      expect(after).toHaveLength(2);
      expect(after[0]).toMatchObject({
        samples: 2,
        windSpeed10mMs: null,
        windSpeed80mMs: 10,
      });
      expect(after[1].samples).toBe(1);
    });

    it('overwrites a stored bucket: the newer fetch wins', async () => {
      await upsertFarmWeather(prisma, 'FARM01', [
        bucket('2026-01-01T00:00:00Z', { windSpeed80mMs: 7, samples: 1 }),
      ]);
      const [first] = await stored();
      const written = await upsertFarmWeather(prisma, 'FARM01', [
        bucket('2026-01-01T00:00:00Z', {
          windSpeed80mMs: 9,
          temperature2mC: null,
        }),
        bucket('2026-01-01T00:30:00Z', { windSpeed80mMs: 9 }),
      ]);
      expect(written).toBe(2);
      const after = await stored();
      expect(
        after.map((r) => [r.samples, r.windSpeed80mMs, r.temperature2mC]),
      ).toEqual([
        [2, 9, null],
        [2, 9, 2],
      ]);
      expect(after[0].fetchedAt.getTime()).toBeGreaterThanOrEqual(
        first.fetchedAt.getTime(),
      );
    });
  });

  it('syncFarmWeather stores a recorded historical day (48 buckets) for every farm, idempotently', async () => {
    const run = () =>
      syncFarmWeather(prisma, {
        from: '2026-01-01',
        to: '2026-01-01',
        now: new Date('2026-10-31T00:00:00Z'),
        fetch: (async () => new Response(HISTORICAL)) as never,
        sleep: async () => undefined,
      });
    const first = await run();
    expect(first.failed).toBe(0);
    expect(first.farms).toHaveLength(10);
    expect(first.farms[0]).toMatchObject({
      historicalBuckets: 48,
      forecastBuckets: 0,
      written: 48,
    });
    await run();
    expect(await prisma.farmWeather.count()).toBe(480);
    expect((await stored())[0]).toMatchObject({
      time: new Date('2026-01-01T00:00:00Z'),
      samples: 2,
      windSpeed80mMs: 10.67,
    });
  });

  describe('farmWeather', () => {
    const DAY = { from: '2026-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' };

    beforeEach(async () => {
      await upsertFarmWeather(prisma, 'FARM01', [
        // Day 1: complete (48 buckets), directions straddling north.
        ...Array.from({ length: 48 }, (_, i) =>
          bucket(new Date(Date.parse(DAY.from) + i * HALF_HOUR_MS), {
            windSpeed80mMs: i, // mean 23.5, max 47
            windDirection80mDeg: i % 2 ? 10 : 350,
            temperature2mC: i - 10, // min -10, max 37
            precipitationMm: i < 4 ? 0.5 : 0, // sum 2
            samples: i === 0 ? 1 : 2,
          }),
        ),
        // Day 2: three buckets, one without a precipitation value.
        bucket('2026-01-02T00:00:00Z', { precipitationMm: null }),
        bucket('2026-01-02T00:30:00Z'),
        bucket('2026-01-02T22:30:00Z', { windDirection80mDeg: 90 }),
      ]);
    });

    it('returns the 30-minute buckets in [from, to), oldest first', async () => {
      const result = await farmWeather(prisma, 'FARM01', {
        from: '2026-01-01T23:00:00Z',
        to: '2026-01-02T00:30:00Z',
        interval: '30min',
      });
      expect(result).toMatchObject({
        farmId: 'FARM01',
        interval: '30min',
        timeZone: 'UTC',
        from: '2026-01-01T23:00:00.000Z',
        to: '2026-01-02T00:30:00.000Z',
      });
      expect(result.points).toEqual([
        expect.objectContaining({ time: '2026-01-01T23:00:00.000Z' }),
        expect.objectContaining({ time: '2026-01-01T23:30:00.000Z' }),
        {
          time: '2026-01-02T00:00:00.000Z',
          samples: 2,
          windSpeed10mMs: 5,
          windSpeed80mMs: 10,
          windDirection10mDeg: 180,
          windDirection80mDeg: 180,
          windGusts10mMs: 12,
          temperature2mC: 2,
          relativeHumidity2mPct: 80,
          surfacePressureHpa: 990,
          precipitationMm: null,
          cloudCoverPct: 50,
        },
      ]);
    });

    it('aggregates UTC days in Postgres; samples = buckets', async () => {
      const result = await farmWeather(prisma, 'FARM01', {
        ...DAY,
        interval: 'daily',
      });
      expect(result.interval).toBe('daily');
      expect(result.points).toEqual([
        {
          date: '2026-01-01',
          samples: 48,
          windSpeed10mMeanMs: 5,
          windSpeed10mMaxMs: 5,
          windSpeed80mMeanMs: 23.5,
          windSpeed80mMaxMs: 47,
          windDirection80mDeg: 0, // vector mean of 350° and 10°, not 180°
          windGusts10mMaxMs: 12,
          temperature2mMinC: -10,
          temperature2mMaxC: 37,
          temperature2mMeanC: 13.5,
          relativeHumidity2mMeanPct: 80,
          surfacePressureMeanHpa: 990,
          precipitationSumMm: 2,
          cloudCoverMeanPct: 50,
        },
        expect.objectContaining({
          date: '2026-01-02',
          samples: 3, // partial day
          precipitationSumMm: 0,
        }),
      ]);
    });

    it('returns no points for a farm without weather in the range', async () => {
      const result = await farmWeather(prisma, 'FARM02', {
        ...DAY,
        interval: 'daily',
      });
      expect(result.points).toEqual([]);
    });

    it('rejects an unknown farm and a range over 31 days', async () => {
      await expect(
        farmWeather(prisma, 'FARM99', { ...DAY, interval: '30min' }),
      ).rejects.toThrow(new QueryNotFoundError('Farm FARM99 not found'));
      await expect(
        farmWeather(prisma, 'FARM01', {
          from: '2026-01-01T00:00:00Z',
          to: '2026-02-02T00:00:00Z',
          interval: 'daily',
        }),
      ).rejects.toThrow(
        new QueryInputError('The range may span at most 31 days'),
      );
    });
  });

  describe('daily buckets in a time zone', () => {
    beforeEach(async () => {
      // Around both 2026 US DST changes (America/Chicago: 03-08 spring forward, 11-01 fall back).
      await upsertFarmWeather(prisma, 'FARM01', [
        ...buckets('2026-03-07T00:00:00Z', '2026-03-10T00:00:00Z'),
        ...buckets('2026-10-31T00:00:00Z', '2026-11-03T00:00:00Z'),
      ]);
    });

    const daily = (from: string, to: string, timeZone?: string) =>
      farmWeather(prisma, 'FARM01', { from, to, interval: 'daily', timeZone });
    const days = (points: { date: string; samples: number }[]) =>
      points.map((p) => [p.date, p.samples]);

    it('gives local calendar days, 50 buckets on the fall-back day', async () => {
      // Local midnight 2026-10-31 (CDT, −5) to local midnight 2026-11-02 (CST, −6).
      const result = await daily(
        '2026-10-31T05:00:00Z',
        '2026-11-02T06:00:00Z',
        'America/Chicago',
      );
      expect(result.timeZone).toBe('America/Chicago');
      expect(days(result.points as never)).toEqual([
        ['2026-10-31', 48],
        ['2026-11-01', 50],
      ]);
    });

    it('gives 46 buckets on the spring-forward day', async () => {
      const result = await daily(
        '2026-03-08T06:00:00Z', // local midnight, CST
        '2026-03-09T05:00:00Z', // local midnight, CDT
        'America/Chicago',
      );
      expect(days(result.points as never)).toEqual([['2026-03-08', 46]]);
    });

    it('shifts the same range against UTC days', async () => {
      const range = ['2026-10-31T05:00:00Z', '2026-11-02T06:00:00Z'] as const;
      expect(days((await daily(...range)).points as never)).toEqual([
        ['2026-10-31', 38], // 05:00–24:00 UTC
        ['2026-11-01', 48],
        ['2026-11-02', 12], // 00:00–06:00 UTC
      ]);
    });

    it('dates east of UTC by the local day (not the UTC day of local midnight)', async () => {
      // Berlin (CET, +1): local 2026-11-01 is 2026-10-31T23:00Z..2026-11-01T23:00Z.
      const result = await daily(
        '2026-10-31T23:00:00Z',
        '2026-11-01T23:00:00Z',
        'Europe/Berlin',
      );
      expect(days(result.points as never)).toEqual([['2026-11-01', 48]]);
    });

    it.each([
      ['an unknown zone', 'Mars/Olympus'],
      ['a POSIX spec Postgres would accept', 'UTC+6'],
      ['a lower-case name', 'america/chicago'],
    ])('rejects %s', async (_, zone) => {
      await expect(
        daily('2026-10-31T00:00:00Z', '2026-11-01T00:00:00Z', zone),
      ).rejects.toThrow(QueryInputError);
    });
  });

  describe('turbineWeather', () => {
    beforeEach(async () => {
      await upsertFarmWeather(prisma, 'FARM02', [
        bucket('2026-01-01T00:00:00Z', { windSpeed80mMs: 7 }),
        bucket('2026-01-01T00:30:00Z', { windSpeed80mMs: 9 }),
      ]);
    });

    it("returns its farm's weather with the turbine id", async () => {
      const result = await turbineWeather(prisma, 'TURB002', {
        from: '2026-01-01T00:00:00Z',
        to: '2026-01-02T00:00:00Z',
        interval: 'daily',
        timeZone: 'America/Denver',
      });
      expect(result).toEqual({
        farmId: 'FARM02',
        turbineId: 'TURB002',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-02T00:00:00.000Z',
        interval: 'daily',
        timeZone: 'America/Denver',
        points: [
          // 00:00Z and 00:30Z are the evening of Dec 31 in Denver (−7).
          expect.objectContaining({
            date: '2025-12-31',
            samples: 2,
            windSpeed80mMeanMs: 8,
          }),
        ],
      });
    });

    it('rejects an unknown turbine', async () => {
      await expect(
        turbineWeather(prisma, 'TURB999', {
          from: '2026-01-01T00:00:00Z',
          to: '2026-01-02T00:00:00Z',
          interval: '30min',
        }),
      ).rejects.toThrow(new QueryNotFoundError('Turbine TURB999 not found'));
    });
  });
});
