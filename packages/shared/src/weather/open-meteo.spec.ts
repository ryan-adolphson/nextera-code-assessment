import { readFileSync } from 'node:fs';
import {
  ARCHIVE_LAG_DAYS,
  OpenMeteoError,
  buildOpenMeteoUrl,
  fetchFarmWeather,
  isUtcDay,
  parseHourly,
  planRequests,
  type FetchFarmWeatherOptions,
} from './open-meteo.js';

/** Recorded Open-Meteo responses (FARM01's coordinates): tests never call the real API. */
const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`./__fixtures__/${name}.json`, import.meta.url),
      'utf8',
    ),
  );
const ARCHIVE = fixture('archive-farm01-2026-01-01');
const FORECAST = fixture('forecast-farm01-2026-10-30');
const INVALID_VARIABLE = fixture('error-invalid-variable');

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const options = (
  overrides: Partial<FetchFarmWeatherOptions> = {},
): FetchFarmWeatherOptions => ({
  latitude: 41.25,
  longitude: -96.53,
  source: 'archive',
  from: '2026-01-01',
  to: '2026-01-01',
  sleep: vi.fn().mockResolvedValue(undefined),
  ...overrides,
});

describe('isUtcDay', () => {
  it.each(['2026-01-01', '2024-02-29'])('accepts %s', (day) => {
    expect(isUtcDay(day)).toBe(true);
  });
  it.each(['2026-02-30', '2025-02-29', '2026-1-01', '2026-01-01T00:00Z', ''])(
    'rejects %j',
    (day) => {
      expect(isUtcDay(day)).toBe(false);
    },
  );
});

describe('planRequests', () => {
  const now = new Date('2026-10-31T09:15:00Z'); // today = 2026-10-31

  it(`reads days before today − ${ARCHIVE_LAG_DAYS} from the archive, the rest from the forecast`, () => {
    expect(planRequests('2026-10-25', '2026-10-31', now)).toEqual([
      { source: 'archive', from: '2026-10-25', to: '2026-10-25' },
      { source: 'forecast', from: '2026-10-26', to: '2026-10-31' },
    ]);
  });

  it('uses only the archive for old days, and only the forecast for recent ones', () => {
    expect(planRequests('2026-01-01', '2026-01-03', now)).toEqual([
      { source: 'archive', from: '2026-01-01', to: '2026-01-03' },
    ]);
    expect(planRequests('2026-10-26', '2026-10-30', now)).toEqual([
      { source: 'forecast', from: '2026-10-26', to: '2026-10-30' },
    ]);
  });

  it('splits archive ranges into chunks of at most 366 days', () => {
    expect(planRequests('2024-01-01', '2026-01-05', now)).toEqual([
      { source: 'archive', from: '2024-01-01', to: '2024-12-31' }, // 366 days (leap year)
      { source: 'archive', from: '2025-01-01', to: '2026-01-01' },
      { source: 'archive', from: '2026-01-02', to: '2026-01-05' },
    ]);
  });

  it('rejects a reversed range, a day after today and a malformed day', () => {
    expect(() => planRequests('2026-01-02', '2026-01-01', now)).toThrow(
      'to must not be before from',
    );
    expect(() => planRequests('2026-10-31', '2026-11-01', now)).toThrow(
      'to must not be after today (2026-10-31)',
    );
    expect(() => planRequests('2026-1-1', '2026-01-02', now)).toThrow(
      'YYYY-MM-DD',
    );
  });
});

describe('buildOpenMeteoUrl', () => {
  it('asks the archive for every variable in m/s, UTC, ISO times', () => {
    const url = buildOpenMeteoUrl(options());
    expect(url.origin + url.pathname).toBe(
      'https://archive-api.open-meteo.com/v1/archive',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      latitude: '41.25',
      longitude: '-96.53',
      start_date: '2026-01-01',
      end_date: '2026-01-01',
      hourly:
        'wind_speed_10m,wind_speed_100m,wind_direction_10m,wind_direction_100m,wind_gusts_10m,' +
        'temperature_2m,relative_humidity_2m,surface_pressure,precipitation,cloud_cover',
      timezone: 'UTC',
      wind_speed_unit: 'ms',
      timeformat: 'iso8601',
    });
  });

  it('uses the forecast API for forecast requests', () => {
    const url = buildOpenMeteoUrl(options({ source: 'forecast' }));
    expect(url.origin + url.pathname).toBe(
      'https://api.open-meteo.com/v1/forecast',
    );
  });

  it('switches to the customer-* hosts with the API key', () => {
    const archive = buildOpenMeteoUrl(options({ apiKey: 'k3y' }));
    const forecast = buildOpenMeteoUrl(
      options({ apiKey: 'k3y', source: 'forecast' }),
    );
    expect(archive.host).toBe('customer-archive-api.open-meteo.com');
    expect(forecast.host).toBe('customer-api.open-meteo.com');
    expect(archive.searchParams.get('apikey')).toBe('k3y');
  });
});

describe('parseHourly', () => {
  const body = (hourly: Record<string, unknown[]>, extra = {}) => ({
    utc_offset_seconds: 0,
    hourly: {
      time: ['2026-01-01T00:00', '2026-01-01T01:00'],
      wind_speed_10m: [5, null],
      wind_speed_100m: [10, null],
      wind_direction_10m: [350, null],
      wind_direction_100m: [355, null],
      wind_gusts_10m: [9, null],
      temperature_2m: [1.5, null],
      relative_humidity_2m: [80, null],
      surface_pressure: [990, null],
      precipitation: [0.2, 0.1],
      cloud_cover: [100, null],
      ...hourly,
    },
    ...extra,
  });

  it('maps the recorded archive day to 24 UTC rows', () => {
    const rows = parseHourly(ARCHIVE, 'archive');
    expect(rows).toHaveLength(24);
    expect(rows[0]).toEqual({
      time: new Date('2026-01-01T00:00:00Z'),
      source: 'archive',
      windSpeed10mMs: 5.03,
      windSpeed100mMs: 10.78,
      windDirection10mDeg: 323,
      windDirection100mDeg: 330,
      windGusts10mMs: 7.4,
      temperature2mC: 5.9,
      relativeHumidity2mPct: 51,
      surfacePressureHpa: 969.3,
      precipitationMm: 0,
      cloudCoverPct: 0,
    });
    expect(rows[23].time).toEqual(new Date('2026-01-01T23:00:00Z'));
  });

  it('keeps nulls of missing values', () => {
    const [, second] = parseHourly(body({}), 'forecast');
    expect(second).toMatchObject({
      source: 'forecast',
      windSpeed10mMs: null,
      temperature2mC: null,
      precipitationMm: 0.1,
    });
  });

  it('drops hours without any value (they would block a later forecast)', () => {
    const rows = parseHourly(body({ precipitation: [0.2, null] }), 'archive');
    expect(rows.map((r) => r.time)).toEqual([new Date('2026-01-01T00:00:00Z')]);
  });

  it.each([
    [
      'mismatched array lengths',
      body({ wind_speed_10m: [5] }),
      'hourly.wind_speed_10m has 1 values for 2 times',
    ],
    [
      'a missing variable',
      body({ cloud_cover: undefined as never }),
      'hourly.cloud_cover is missing',
    ],
    [
      'a non-numeric value',
      body({ temperature_2m: ['1', null] }),
      'non-numeric',
    ],
    [
      'a bad time',
      body({ time: ['2026-01-01 00:00', '2026-01-01T01:00'] }),
      'bad time',
    ],
    ['a non-UTC offset', body({}, { utc_offset_seconds: 3600 }), 'not UTC'],
    ['no hourly object', { error: false }, 'no hourly object'],
  ])('rejects %s', (_case, input, message) => {
    expect(() => parseHourly(input, 'archive')).toThrow(message);
  });
});

describe('fetchFarmWeather', () => {
  it('fetches and maps a forecast day', async () => {
    const fetch = vi.fn().mockResolvedValue(json(FORECAST));
    const rows = await fetchFarmWeather(
      options({
        source: 'forecast',
        from: '2026-10-30',
        to: '2026-10-30',
        fetch,
      }),
    );
    expect(rows).toHaveLength(24);
    expect(rows[0]).toMatchObject({
      source: 'forecast',
      time: new Date('2026-10-30T00:00:00Z'),
      windSpeed100mMs: 8.2,
    });
    const [url, init] = fetch.mock.calls[0];
    expect(String(url)).toContain('https://api.open-meteo.com/v1/forecast?');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([429, 500, 503])('retries HTTP %i and succeeds', async (status) => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(json({ error: true, reason: 'busy' }, status))
      .mockResolvedValueOnce(json(ARCHIVE));
    const rows = await fetchFarmWeather(options({ fetch, sleep }));
    expect(rows).toHaveLength(24);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000);
  });

  it('gives up after 3 attempts with backoff', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetch = vi
      .fn()
      .mockImplementation(async () =>
        json({ error: true, reason: 'Too many' }, 429),
      );
    const error = await fetchFarmWeather(options({ fetch, sleep })).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(OpenMeteoError);
    expect(error).toMatchObject({
      status: 429,
      transient: true,
      message: 'Open-Meteo archive 2026-01-01..2026-01-01: HTTP 429 (Too many)',
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls).toEqual([[1000], [2000]]);
  });

  it('does not retry a 400, and reports Open-Meteo’s reason', async () => {
    const fetch = vi.fn().mockResolvedValue(json(INVALID_VARIABLE, 400));
    await expect(fetchFarmWeather(options({ fetch }))).rejects.toMatchObject({
      status: 400,
      transient: false,
      message: expect.stringMatching(
        /^Open-Meteo archive .*: HTTP 400 \(Invalid value: /,
      ),
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('times out a hanging request and retries it', async () => {
    const hang = (_url: URL, init: RequestInit) =>
      new Promise<Response>((_resolve, reject) =>
        init.signal!.addEventListener('abort', () =>
          reject(init.signal!.reason),
        ),
      );
    const fetch = vi
      .fn()
      .mockImplementationOnce(hang)
      .mockResolvedValueOnce(json(ARCHIVE));
    const rows = await fetchFarmWeather(options({ fetch, timeoutMs: 10 }));
    expect(rows).toHaveLength(24);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('reports a timeout when every attempt hangs', async () => {
    const fetch = vi.fn(
      (_url: URL, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init.signal!.addEventListener('abort', () =>
            reject(init.signal!.reason),
          ),
        ),
    );
    await expect(
      fetchFarmWeather(options({ fetch: fetch as never, timeoutMs: 5 })),
    ).rejects.toThrow('no response within 5 ms');
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('retries network errors', async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(json(ARCHIVE));
    await expect(fetchFarmWeather(options({ fetch }))).resolves.toHaveLength(
      24,
    );
  });

  it('fails at once on a malformed body', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(json({ hourly: { time: ['2026-01-01T00:00'] } }));
    await expect(fetchFarmWeather(options({ fetch }))).rejects.toThrow(
      'hourly.wind_speed_10m is missing',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
