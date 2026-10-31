import { readFileSync } from 'node:fs';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { Prisma } from '../generated/prisma/client.js';
import {
  syncFarmWeather,
  upsertWeatherHours,
  type WeatherWriteClient,
} from './sync-weather.js';

const ARCHIVE = readFileSync(
  new URL('./__fixtures__/archive-farm01-2026-01-01.json', import.meta.url),
  'utf8',
);
const FORECAST = readFileSync(
  new URL('./__fixtures__/forecast-farm01-2026-10-30.json', import.meta.url),
  'utf8',
);

const farm = (id: string, latitude: string) => ({
  id,
  latitude: new Prisma.Decimal(latitude),
  longitude: new Prisma.Decimal('-96.53'),
});

/** The SQL text and values of the n-th $executeRaw call. */
const executed = (db: DeepMockProxy<WeatherWriteClient>, n = 0) => {
  const [strings, ...values] = db.$executeRaw.mock.calls[n] as unknown as [
    TemplateStringsArray,
    ...unknown[],
  ];
  const sql = Prisma.sql(strings, ...values);
  return { text: sql.sql.replace(/\s+/g, ' '), values: sql.values };
};

describe('upsertWeatherHours', () => {
  it('inserts every hour in one statement, archive wins over forecast', async () => {
    const db = mockDeep<WeatherWriteClient>();
    db.$executeRaw.mockResolvedValue(2);
    const row = (hour: number, value: number | null) => ({
      time: new Date(Date.UTC(2026, 0, 1, hour)),
      source: 'archive' as const,
      windSpeed10mMs: value,
      windSpeed100mMs: 1,
      windDirection10mDeg: 1,
      windDirection100mDeg: 1,
      windGusts10mMs: 1,
      temperature2mC: 1,
      relativeHumidity2mPct: 1,
      surfacePressureHpa: 1,
      precipitationMm: 1,
      cloudCoverPct: 1,
    });

    // The duplicate hour is sent once (the last one wins).
    const written = await upsertWeatherHours(db, 'FARM01', [
      row(0, 1),
      row(1, null),
      row(0, 3),
    ]);

    expect(written).toBe(2);
    const { text, values } = executed(db);
    expect(text).toContain(
      'ON CONFLICT (farm_id, time) DO UPDATE SET wind_speed_10m_ms = EXCLUDED.wind_speed_10m_ms,',
    );
    expect(text).toContain(
      "WHERE farm_weather_hourly.source = 'forecast' OR EXCLUDED.source = 'archive'",
    );
    expect(values.slice(0, 4)).toEqual([
      'FARM01',
      ['2026-01-01T00:00:00.000Z', '2026-01-01T01:00:00.000Z'],
      ['archive', 'archive'],
      [3, null],
    ]);
  });

  it('writes nothing for no rows', async () => {
    const db = mockDeep<WeatherWriteClient>();
    expect(await upsertWeatherHours(db, 'FARM01', [])).toBe(0);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
});

describe('syncFarmWeather', () => {
  const now = new Date('2026-10-31T09:00:00Z');
  let db: DeepMockProxy<WeatherWriteClient>;
  let log: ReturnType<typeof vi.fn<(line: string) => void>>;
  const sleep = vi.fn().mockResolvedValue(undefined);

  beforeEach(() => {
    db = mockDeep<WeatherWriteClient>();
    db.$executeRaw.mockImplementation((async () => 24) as never);
    log = vi.fn<(line: string) => void>();
    sleep.mockClear();
  });

  it('fetches the archive and forecast parts of each farm and stores them', async () => {
    db.farm.findMany.mockResolvedValue([farm('FARM01', '41.25')] as never);
    const fetch = vi.fn(
      async (url: URL) =>
        new Response(url.host.startsWith('archive') ? ARCHIVE : FORECAST),
    );

    const result = await syncFarmWeather(db, {
      from: '2026-10-25',
      to: '2026-10-26',
      now,
      fetch: fetch as never,
      sleep,
      log,
    });

    expect(
      fetch.mock.calls.map(([url]) => url.searchParams.get('start_date')),
    ).toEqual(['2026-10-25', '2026-10-26']);
    expect(result).toEqual({
      from: '2026-10-25',
      to: '2026-10-26',
      failed: 0,
      farms: [
        {
          farmId: 'FARM01',
          ok: true,
          archiveHours: 24,
          forecastHours: 24,
          written: 48,
        },
      ],
    });
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1); // between the two requests
    expect(log).toHaveBeenCalledWith(
      'FARM01: ok: 24 archive + 24 forecast hours, 48 rows written',
    );
  });

  it('isolates a failing farm: the others are still synced', async () => {
    db.farm.findMany.mockResolvedValue([
      farm('FARM01', '41.25'),
      farm('FARM02', '42.5'),
      farm('FARM03', '43.5'),
    ] as never);
    const fetch = vi.fn(async (url: URL) =>
      url.searchParams.get('latitude') === '42.5'
        ? new Response('{"error":true,"reason":"Latitude bad"}', {
            status: 400,
          })
        : new Response(ARCHIVE),
    );

    const result = await syncFarmWeather(db, {
      from: '2026-01-01',
      to: '2026-01-01',
      now,
      fetch: fetch as never,
      sleep,
      log,
    });

    expect(result.failed).toBe(1);
    expect(result.farms.map((f) => [f.farmId, f.ok])).toEqual([
      ['FARM01', true],
      ['FARM02', false],
      ['FARM03', true],
    ]);
    expect(result.farms[1].error).toBe(
      'Open-Meteo archive 2026-01-01..2026-01-01: HTTP 400 (Latitude bad)',
    );
    expect(log).toHaveBeenCalledWith(
      'FARM02: failed: Open-Meteo archive 2026-01-01..2026-01-01: HTTP 400 (Latitude bad)',
    );
  });

  it('only syncs the requested farms and reports unknown ones as failures', async () => {
    db.farm.findMany.mockResolvedValue([farm('FARM01', '41.25')] as never);
    const fetch = vi.fn(async () => new Response(ARCHIVE));

    const result = await syncFarmWeather(db, {
      from: '2026-01-01',
      to: '2026-01-01',
      farmIds: ['FARM01', 'FARM99'],
      now,
      fetch: fetch as never,
      sleep,
      log,
    });

    expect(db.farm.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['FARM01', 'FARM99'] } },
      orderBy: { id: 'asc' },
      select: { id: true, latitude: true, longitude: true },
    });
    expect(result.failed).toBe(1);
    expect(result.farms).toEqual([
      expect.objectContaining({ farmId: 'FARM01', ok: true }),
      expect.objectContaining({
        farmId: 'FARM99',
        ok: false,
        error: 'Farm FARM99 not found',
      }),
    ]);
  });

  it('rejects an invalid range before any request', async () => {
    const fetch = vi.fn();
    await expect(
      syncFarmWeather(db, {
        from: '2026-01-02',
        to: '2026-01-01',
        now,
        fetch,
      }),
    ).rejects.toThrow('to must not be before from');
    expect(fetch).not.toHaveBeenCalled();
    expect(db.farm.findMany).not.toHaveBeenCalled();
  });
});
