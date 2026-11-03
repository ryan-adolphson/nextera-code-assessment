import { readFileSync } from 'node:fs';
import {
  HISTORICAL_LAG_DAYS,
  OpenMeteoError,
  buildOpenMeteoUrl,
  fetchFarmWeather,
  isUtcDay,
  parseMinutely15,
  planRequests,
  toHalfHourBuckets,
  type FetchFarmWeatherOptions,
  type WeatherSample,
} from './open-meteo.js';

/** Recorded Open-Meteo responses (FARM01's coordinates): tests never call the real API. */
const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(
      new URL(`./__fixtures__/${name}.json`, import.meta.url),
      'utf8',
    ),
  );
const HISTORICAL = fixture('historical-farm01-2026-01-01');
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
  api: 'historical',
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

  it(`reads days before today − ${HISTORICAL_LAG_DAYS} from the Historical Forecast API, the rest from the Forecast API`, () => {
    expect(planRequests('2026-10-25', '2026-10-31', now)).toEqual([
      { api: 'historical', from: '2026-10-25', to: '2026-10-25' },
      { api: 'forecast', from: '2026-10-26', to: '2026-10-31' },
    ]);
  });

  it('uses only one API for old days, or for recent ones', () => {
    expect(planRequests('2026-01-01', '2026-01-03', now)).toEqual([
      { api: 'historical', from: '2026-01-01', to: '2026-01-03' },
    ]);
    expect(planRequests('2026-10-26', '2026-10-30', now)).toEqual([
      { api: 'forecast', from: '2026-10-26', to: '2026-10-30' },
    ]);
  });

  it('splits historical ranges into chunks of at most 92 days', () => {
    expect(planRequests('2026-01-01', '2026-07-05', now)).toEqual([
      { api: 'historical', from: '2026-01-01', to: '2026-04-02' }, // 92 days
      { api: 'historical', from: '2026-04-03', to: '2026-07-03' },
      { api: 'historical', from: '2026-07-04', to: '2026-07-05' },
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
  it('asks the Historical Forecast API for every 15-minute variable in m/s, UTC, ISO times', () => {
    const url = buildOpenMeteoUrl(options());
    expect(url.origin + url.pathname).toBe(
      'https://historical-forecast-api.open-meteo.com/v1/forecast',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      latitude: '41.25',
      longitude: '-96.53',
      start_date: '2026-01-01',
      end_date: '2026-01-01',
      minutely_15:
        'wind_speed_10m,wind_speed_80m,wind_direction_10m,wind_direction_80m,wind_gusts_10m,' +
        'temperature_2m,relative_humidity_2m,surface_pressure,precipitation,cloud_cover',
      timezone: 'UTC',
      wind_speed_unit: 'ms',
      timeformat: 'iso8601',
    });
  });

  it('uses the Forecast API for recent days', () => {
    const url = buildOpenMeteoUrl(options({ api: 'forecast' }));
    expect(url.origin + url.pathname).toBe(
      'https://api.open-meteo.com/v1/forecast',
    );
  });

  it('switches to the customer-* hosts with the API key', () => {
    const historical = buildOpenMeteoUrl(options({ apiKey: 'k3y' }));
    const forecast = buildOpenMeteoUrl(
      options({ apiKey: 'k3y', api: 'forecast' }),
    );
    expect(historical.host).toBe(
      'customer-historical-forecast-api.open-meteo.com',
    );
    expect(forecast.host).toBe('customer-api.open-meteo.com');
    expect(historical.searchParams.get('apikey')).toBe('k3y');
  });
});

describe('parseMinutely15', () => {
  const body = (series: Record<string, unknown[]>, extra = {}) => ({
    utc_offset_seconds: 0,
    minutely_15: {
      time: ['2026-01-01T00:00', '2026-01-01T00:15'],
      wind_speed_10m: [5, null],
      wind_speed_80m: [10, null],
      wind_direction_10m: [350, null],
      wind_direction_80m: [355, null],
      wind_gusts_10m: [9, null],
      temperature_2m: [1.5, null],
      relative_humidity_2m: [80, null],
      surface_pressure: [990, null],
      precipitation: [0.2, 0.1],
      cloud_cover: [100, null],
      ...series,
    },
    ...extra,
  });

  it('maps the recorded historical day to 96 UTC value sets', () => {
    const samples = parseMinutely15(HISTORICAL);
    expect(samples).toHaveLength(96);
    expect(samples[0]).toEqual({
      time: new Date('2026-01-01T00:00:00Z'),
      windSpeed10mMs: 4.16,
      windSpeed80mMs: 10.48,
      windDirection10mDeg: 333,
      windDirection80mDeg: 331,
      windGusts10mMs: 8.9,
      temperature2mC: 7.1,
      relativeHumidity2mPct: 46,
      surfacePressureHpa: 968.5,
      precipitationMm: 0,
      cloudCoverPct: 0,
    });
    expect(samples[95].time).toEqual(new Date('2026-01-01T23:45:00Z'));
  });

  it('keeps nulls of missing values', () => {
    const [, second] = parseMinutely15(body({}));
    expect(second).toMatchObject({
      windSpeed10mMs: null,
      temperature2mC: null,
      precipitationMm: 0.1,
    });
  });

  it.each([
    [
      'mismatched array lengths',
      body({ wind_speed_10m: [5] }),
      'minutely_15.wind_speed_10m has 1 values for 2 times',
    ],
    [
      'a missing variable',
      body({ cloud_cover: undefined as never }),
      'minutely_15.cloud_cover is missing',
    ],
    [
      'a non-numeric value',
      body({ temperature_2m: ['1', null] }),
      'non-numeric',
    ],
    [
      'a bad time',
      body({ time: ['2026-01-01 00:00', '2026-01-01T00:15'] }),
      'bad time',
    ],
    [
      'a time off the 15-minute grid',
      body({ time: ['2026-01-01T00:00', '2026-01-01T00:20'] }),
      'bad time',
    ],
    ['a non-UTC offset', body({}, { utc_offset_seconds: 3600 }), 'not UTC'],
    ['hourly data only', { hourly: { time: [] } }, 'no minutely_15 object'],
  ])('rejects %s', (_case, input, message) => {
    expect(() => parseMinutely15(input)).toThrow(message);
  });
});

describe('toHalfHourBuckets', () => {
  const sample = (
    iso: string,
    values: Partial<WeatherSample> = {},
  ): WeatherSample => ({
    time: new Date(iso),
    windSpeed10mMs: 4,
    windSpeed80mMs: 10,
    windDirection10mDeg: 180,
    windDirection80mDeg: 180,
    windGusts10mMs: 8,
    temperature2mC: 2,
    relativeHumidity2mPct: 80,
    surfacePressureHpa: 990,
    precipitationMm: 0.1,
    cloudCoverPct: 50,
    ...values,
  });
  const empty = Object.fromEntries(
    [
      'windSpeed10mMs',
      'windSpeed80mMs',
      'windDirection10mDeg',
      'windDirection80mDeg',
      'windGusts10mMs',
      'temperature2mC',
      'relativeHumidity2mPct',
      'surfacePressureHpa',
      'precipitationMm',
      'cloudCoverPct',
    ].map((k) => [k, null]),
  );

  it('aggregates :00 + :15 and :30 + :45: means, max gust, summed precipitation, vector-mean directions', () => {
    const buckets = toHalfHourBuckets([
      sample('2026-01-01T00:00:00Z', {
        windSpeed80mMs: 10,
        windDirection80mDeg: 350,
        windDirection10mDeg: 90,
        windGusts10mMs: 8,
        precipitationMm: 0.1,
        temperature2mC: 1,
      }),
      sample('2026-01-01T00:15:00Z', {
        windSpeed80mMs: 11,
        windDirection80mDeg: 10,
        windDirection10mDeg: 180,
        windGusts10mMs: 9.5,
        precipitationMm: 0.2,
        temperature2mC: 2,
      }),
      sample('2026-01-01T00:30:00Z', { windSpeed80mMs: 7 }),
      sample('2026-01-01T00:45:00Z', { windSpeed80mMs: 9 }),
    ]);

    expect(buckets).toEqual([
      {
        time: new Date('2026-01-01T00:00:00Z'),
        samples: 2,
        windSpeed10mMs: 4,
        windSpeed80mMs: 10.5,
        windDirection10mDeg: 135,
        windDirection80mDeg: 0, // vector mean of 350° and 10°, not 180°
        windGusts10mMs: 9.5,
        temperature2mC: 1.5,
        relativeHumidity2mPct: 80,
        surfacePressureHpa: 990,
        precipitationMm: 0.3, // not 0.30000000000000004
        cloudCoverPct: 50,
      },
      expect.objectContaining({
        time: new Date('2026-01-01T00:30:00Z'),
        samples: 2,
        windSpeed80mMs: 8,
      }),
    ]);
  });

  it('counts only value sets with a value, and aggregates each metric over the values present', () => {
    const buckets = toHalfHourBuckets([
      sample('2026-01-01T01:00:00Z', { windSpeed80mMs: null }),
      sample('2026-01-01T01:15:00Z', { windSpeed80mMs: 12 }),
      sample('2026-01-01T01:30:00Z', { ...empty, temperature2mC: 3 }),
      { time: new Date('2026-01-01T01:45:00Z'), ...empty } as WeatherSample,
    ]);

    expect(buckets.map((b) => [b.time.toISOString(), b.samples])).toEqual([
      ['2026-01-01T01:00:00.000Z', 2],
      ['2026-01-01T01:30:00.000Z', 1],
    ]);
    expect(buckets[0].windSpeed80mMs).toBe(12);
    expect(buckets[1]).toMatchObject({
      temperature2mC: 3,
      windSpeed80mMs: null,
      precipitationMm: null,
    });
  });

  it('drops buckets without any value, and sorts by time', () => {
    const buckets = toHalfHourBuckets([
      sample('2026-01-01T03:00:00Z'),
      { time: new Date('2026-01-01T02:00:00Z'), ...empty } as WeatherSample,
      { time: new Date('2026-01-01T02:15:00Z'), ...empty } as WeatherSample,
      sample('2026-01-01T01:30:00Z'),
    ]);
    expect(buckets.map((b) => b.time.toISOString())).toEqual([
      '2026-01-01T01:30:00.000Z',
      '2026-01-01T03:00:00.000Z',
    ]);
  });

  it('turns the recorded historical day into 48 complete buckets', () => {
    const buckets = toHalfHourBuckets(parseMinutely15(HISTORICAL));
    expect(buckets).toHaveLength(48);
    expect(buckets.every((b) => b.samples === 2)).toBe(true);
    expect(buckets[0]).toMatchObject({
      time: new Date('2026-01-01T00:00:00Z'),
      windSpeed80mMs: 10.67, // (10.48 + 10.85) / 2 = 10.665
      windGusts10mMs: 9.2, // max(8.9, 9.2)
      surfacePressureHpa: 968.55,
    });
    expect(buckets[47].time).toEqual(new Date('2026-01-01T23:30:00Z'));
  });
});

describe('fetchFarmWeather', () => {
  it('fetches a forecast day and returns 30-minute buckets', async () => {
    const fetch = vi.fn().mockResolvedValue(json(FORECAST));
    const rows = await fetchFarmWeather(
      options({
        api: 'forecast',
        from: '2026-10-30',
        to: '2026-10-30',
        fetch,
      }),
    );
    expect(rows).toHaveLength(48);
    expect(rows[0]).toMatchObject({
      time: new Date('2026-10-30T00:00:00Z'),
      samples: 2,
      windSpeed80mMs: 5.91, // (5.4 + 6.42) / 2
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
      .mockResolvedValueOnce(json(HISTORICAL));
    const rows = await fetchFarmWeather(options({ fetch, sleep }));
    expect(rows).toHaveLength(48);
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
      message:
        'Open-Meteo historical 2026-01-01..2026-01-01: HTTP 429 (Too many)',
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
        /^Open-Meteo historical .*: HTTP 400 \(Invalid value: /,
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
      .mockResolvedValueOnce(json(HISTORICAL));
    const rows = await fetchFarmWeather(options({ fetch, timeoutMs: 10 }));
    expect(rows).toHaveLength(48);
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
      .mockResolvedValueOnce(json(HISTORICAL));
    await expect(fetchFarmWeather(options({ fetch }))).resolves.toHaveLength(
      48,
    );
  });

  it('fails at once on a malformed body', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(json({ minutely_15: { time: ['2026-01-01T00:00'] } }));
    await expect(fetchFarmWeather(options({ fetch }))).rejects.toThrow(
      'minutely_15.wind_speed_10m is missing',
    );
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
