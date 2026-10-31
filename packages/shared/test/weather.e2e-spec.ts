import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { seedFarmsFromCsv } from '../src/seed/seed-from-csv.js';
import type { WeatherHourRow } from '../src/weather/open-meteo.js';
import {
  syncFarmWeather,
  upsertWeatherHours,
} from '../src/weather/sync-weather.js';
import {
  QueryInputError,
  QueryNotFoundError,
  farmWeather,
} from '../src/wind/queries.js';
import { openMigrationDb, type MigrationDb } from './migration-db.js';

const DATA_DIR = fileURLToPath(new URL('../prisma/data', import.meta.url));
const ARCHIVE = readFileSync(
  new URL(
    '../src/weather/__fixtures__/archive-farm01-2026-01-01.json',
    import.meta.url,
  ),
  'utf8',
);

const hour = (
  iso: string,
  source: 'archive' | 'forecast',
  values: Partial<WeatherHourRow> = {},
): WeatherHourRow => ({
  time: new Date(iso),
  source,
  windSpeed10mMs: 5,
  windSpeed100mMs: 10,
  windDirection10mDeg: 180,
  windDirection100mDeg: 180,
  windGusts10mMs: 12,
  temperature2mC: 2,
  relativeHumidity2mPct: 80,
  surfacePressureHpa: 990,
  precipitationMm: 0,
  cloudCoverPct: 50,
  ...values,
});

/** The weather upsert (archive wins) and the farmWeather read against a real Postgres. */
describe('farm weather (e2e)', () => {
  let m: MigrationDb;
  let prisma: PrismaClient;

  beforeAll(async () => {
    m = await openMigrationDb('99999999999999_weather');
    await m.migrateAll();
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: m.url }),
    });
    await seedFarmsFromCsv(prisma, DATA_DIR);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await m?.close();
  });

  beforeEach(async () => {
    await prisma.$executeRaw`TRUNCATE TABLE farm_weather_hourly`;
  });

  const stored = () =>
    prisma.farmWeatherHourly.findMany({
      where: { farmId: 'FARM01' },
      orderBy: { time: 'asc' },
    });

  describe('upsertWeatherHours', () => {
    it('stores nulls and is idempotent', async () => {
      const rows = [
        hour('2026-01-01T00:00:00Z', 'archive', { windSpeed10mMs: null }),
        hour('2026-01-01T01:00:00Z', 'archive'),
      ];
      expect(await upsertWeatherHours(prisma, 'FARM01', rows)).toBe(2);
      expect(await upsertWeatherHours(prisma, 'FARM01', rows)).toBe(2); // refreshed
      const after = await stored();
      expect(after).toHaveLength(2);
      expect(after[0]).toMatchObject({
        source: 'archive',
        windSpeed10mMs: null,
        windSpeed100mMs: 10,
      });
    });

    it('never overwrites an archive hour with a forecast', async () => {
      await upsertWeatherHours(prisma, 'FARM01', [
        hour('2026-01-01T00:00:00Z', 'archive', { windSpeed100mMs: 7 }),
      ]);
      const written = await upsertWeatherHours(prisma, 'FARM01', [
        hour('2026-01-01T00:00:00Z', 'forecast', { windSpeed100mMs: 99 }),
        hour('2026-01-01T01:00:00Z', 'forecast', { windSpeed100mMs: 99 }),
      ]);
      expect(written).toBe(1); // only the new hour
      expect(
        (await stored()).map((r) => [r.source, r.windSpeed100mMs]),
      ).toEqual([
        ['archive', 7],
        ['forecast', 99],
      ]);
    });

    it('replaces a forecast hour with a newer forecast, then with the archive', async () => {
      await upsertWeatherHours(prisma, 'FARM01', [
        hour('2026-01-01T00:00:00Z', 'forecast', { temperature2mC: 1 }),
      ]);
      await upsertWeatherHours(prisma, 'FARM01', [
        hour('2026-01-01T00:00:00Z', 'forecast', { temperature2mC: 2 }),
      ]);
      expect((await stored())[0]).toMatchObject({
        source: 'forecast',
        temperature2mC: 2,
      });
      await upsertWeatherHours(prisma, 'FARM01', [
        hour('2026-01-01T00:00:00Z', 'archive', { temperature2mC: 3 }),
      ]);
      expect((await stored())[0]).toMatchObject({
        source: 'archive',
        temperature2mC: 3,
      });
    });
  });

  it('syncFarmWeather stores a recorded archive day for every farm, idempotently', async () => {
    const run = () =>
      syncFarmWeather(prisma, {
        from: '2026-01-01',
        to: '2026-01-01',
        now: new Date('2026-10-31T00:00:00Z'),
        fetch: (async () => new Response(ARCHIVE)) as never,
        sleep: async () => undefined,
      });
    const first = await run();
    expect(first.failed).toBe(0);
    expect(first.farms).toHaveLength(10);
    expect(first.farms[0]).toMatchObject({ archiveHours: 24, written: 24 });
    await run();
    expect(await prisma.farmWeatherHourly.count()).toBe(240);
  });

  describe('farmWeather', () => {
    const DAY = { from: '2026-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' };

    beforeEach(async () => {
      await upsertWeatherHours(prisma, 'FARM01', [
        // Day 1: complete archive day, directions straddling north.
        ...Array.from({ length: 24 }, (_, h) =>
          hour(`2026-01-01T${String(h).padStart(2, '0')}:00:00Z`, 'archive', {
            windSpeed100mMs: h, // mean 11.5, max 23
            windDirection100mDeg: h % 2 ? 10 : 350,
            temperature2mC: h - 10, // min -10, max 13
            precipitationMm: h < 4 ? 0.5 : 0, // sum 2
          }),
        ),
        // Day 2: three hours, one of them a forecast, one with no precipitation value.
        hour('2026-01-02T00:00:00Z', 'archive', { precipitationMm: null }),
        hour('2026-01-02T01:00:00Z', 'archive'),
        hour('2026-01-02T22:00:00Z', 'forecast', {
          windDirection100mDeg: 90,
        }),
      ]);
    });

    it('returns the hours in [from, to), oldest first', async () => {
      const result = await farmWeather(prisma, 'FARM01', {
        from: '2026-01-01T22:00:00Z',
        to: '2026-01-02T01:00:00Z',
        interval: 'hourly',
      });
      expect(result).toMatchObject({
        farmId: 'FARM01',
        interval: 'hourly',
        from: '2026-01-01T22:00:00.000Z',
        to: '2026-01-02T01:00:00.000Z',
      });
      expect(result.points).toEqual([
        expect.objectContaining({ time: '2026-01-01T22:00:00.000Z' }),
        expect.objectContaining({ time: '2026-01-01T23:00:00.000Z' }),
        {
          time: '2026-01-02T00:00:00.000Z',
          source: 'archive',
          windSpeed10mMs: 5,
          windSpeed100mMs: 10,
          windDirection10mDeg: 180,
          windDirection100mDeg: 180,
          windGusts10mMs: 12,
          temperature2mC: 2,
          relativeHumidity2mPct: 80,
          surfacePressureHpa: 990,
          precipitationMm: null,
          cloudCoverPct: 50,
        },
      ]);
    });

    it('aggregates UTC days in Postgres', async () => {
      const result = await farmWeather(prisma, 'FARM01', {
        ...DAY,
        interval: 'daily',
      });
      expect(result.interval).toBe('daily');
      expect(result.points).toEqual([
        {
          date: '2026-01-01',
          hours: 24,
          source: 'archive',
          windSpeed10mMeanMs: 5,
          windSpeed10mMaxMs: 5,
          windSpeed100mMeanMs: 11.5,
          windSpeed100mMaxMs: 23,
          windGusts10mMaxMs: 12,
          windDirection100mDeg: 0, // vector mean of 350° and 10°, not 180°
          temperature2mMinC: -10,
          temperature2mMaxC: 13,
          temperature2mMeanC: 1.5,
          relativeHumidity2mMeanPct: 80,
          surfacePressureMeanHpa: 990,
          precipitationSumMm: 2,
          cloudCoverMeanPct: 50,
        },
        expect.objectContaining({
          date: '2026-01-02',
          hours: 3, // partial day
          source: 'forecast', // one forecast hour
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
        farmWeather(prisma, 'FARM99', { ...DAY, interval: 'hourly' }),
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
});
