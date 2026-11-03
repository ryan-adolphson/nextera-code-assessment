import { setTimeout as delay } from 'node:timers/promises';

/**
 * Open-Meteo client for the farm weather dataset (30-minute rows in farm_weather).
 *
 * Only the forecast models, at 15-minute resolution (`minutely_15`; native in North America and
 * Central Europe, interpolated from hourly elsewhere), two APIs with the same models and response:
 * - days older than HISTORICAL_LAG_DAYS come from the Historical Forecast API (the archived
 *   forecasts, from about 2022);
 * - the more recent days (up to today) from the Forecast API with start_date/end_date.
 * There is no reanalysis (ERA5): a later fetch of a day simply overwrites its rows.
 *
 * Each pair of 15-minute values (:00 + :15, :30 + :45) is aggregated into one 30-minute bucket
 * (`toHalfHourBuckets`).
 *
 * Licence: the free API is for non-commercial use only (about 10k calls a day). With an API key
 * the paid `customer-*` hosts are used with `&apikey=`.
 */

/** Days before today − 5 (UTC) are read from the Historical Forecast API, the rest from the Forecast API. */
export const HISTORICAL_LAG_DAYS = 5;
/** The widest single request (about 9k 15-minute steps): longer ranges are split. */
export const MAX_REQUEST_DAYS = 92;
export const OPEN_METEO_TIMEOUT_MS = 15_000;
export const OPEN_METEO_ATTEMPTS = 3;
/** Backoff before the 2nd and 3rd attempt: 1 s, then 2 s. */
export const OPEN_METEO_BACKOFF_MS = 1_000;

/** Fields of a 30-minute bucket (Prisma names of farm_weather's metric columns). */
export type WeatherMetric =
  | 'windSpeed10mMs'
  | 'windSpeed80mMs'
  | 'windDirection10mDeg'
  | 'windDirection80mDeg'
  | 'windGusts10mMs'
  | 'temperature2mC'
  | 'relativeHumidity2mPct'
  | 'surfacePressureHpa'
  | 'precipitationMm'
  | 'cloudCoverPct';

/** How the two 15-minute values of a bucket become one: mean, max, sum or vector mean (directions). */
export type WeatherAggregate = 'mean' | 'max' | 'sum' | 'direction';

/**
 * Each stored metric: the Open-Meteo `minutely_15` variable (with `wind_speed_unit=ms`), the Prisma
 * field, the column and the 30-minute aggregate. Fixed constants, so SQL built from `column` is safe.
 */
export const WEATHER_VARIABLES: readonly {
  api: string;
  field: WeatherMetric;
  column: string;
  aggregate: WeatherAggregate;
}[] = [
  {
    api: 'wind_speed_10m',
    field: 'windSpeed10mMs',
    column: 'wind_speed_10m_ms',
    aggregate: 'mean',
  },
  {
    api: 'wind_speed_80m',
    field: 'windSpeed80mMs',
    column: 'wind_speed_80m_ms',
    aggregate: 'mean',
  },
  {
    api: 'wind_direction_10m',
    field: 'windDirection10mDeg',
    column: 'wind_direction_10m_deg',
    aggregate: 'direction',
  },
  {
    api: 'wind_direction_80m',
    field: 'windDirection80mDeg',
    column: 'wind_direction_80m_deg',
    aggregate: 'direction',
  },
  {
    api: 'wind_gusts_10m',
    field: 'windGusts10mMs',
    column: 'wind_gusts_10m_ms',
    aggregate: 'max',
  },
  {
    api: 'temperature_2m',
    field: 'temperature2mC',
    column: 'temperature_2m_c',
    aggregate: 'mean',
  },
  {
    api: 'relative_humidity_2m',
    field: 'relativeHumidity2mPct',
    column: 'relative_humidity_2m_pct',
    aggregate: 'mean',
  },
  {
    api: 'surface_pressure',
    field: 'surfacePressureHpa',
    column: 'surface_pressure_hpa',
    aggregate: 'mean',
  },
  {
    api: 'precipitation',
    field: 'precipitationMm',
    column: 'precipitation_mm',
    aggregate: 'sum',
  },
  {
    api: 'cloud_cover',
    field: 'cloudCoverPct',
    column: 'cloud_cover_pct',
    aggregate: 'mean',
  },
];

/** One 15-minute value set as Open-Meteo returns it (UTC). */
export type WeatherSample = { time: Date } & Record<
  WeatherMetric,
  number | null
>;

/** One 30-minute bucket as stored (farm_weather without farm_id and fetched_at). */
export type WeatherBucketRow = {
  /** Start of the UTC bucket (:00 or :30). */
  time: Date;
  /** 15-minute value sets with at least one value (1 or 2). */
  samples: number;
} & Record<WeatherMetric, number | null>;

/** Which Open-Meteo API a request goes to (not stored: both serve the same forecast models). */
export type WeatherApi = 'historical' | 'forecast';

/** One Open-Meteo request: whole UTC days, `from`..`to` inclusive (YYYY-MM-DD). */
export interface WeatherRequest {
  api: WeatherApi;
  from: string;
  to: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The UTC day of an instant (YYYY-MM-DD). */
export const utcDay = (at: Date): string => at.toISOString().slice(0, 10);

/** True for a real calendar day written as YYYY-MM-DD. */
export function isUtcDay(value: string): boolean {
  const match = DAY_PATTERN.exec(value);
  if (!match) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && utcDay(date) === value;
}

/** `day` (YYYY-MM-DD) plus `days` (may be negative). */
export const addDays = (day: string, days: number): string =>
  utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS));

const daysBetween = (from: string, to: string) =>
  Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS,
  );

/**
 * Splits the UTC days `from`..`to` (inclusive) into Open-Meteo requests: the Historical Forecast
 * API for days before today − HISTORICAL_LAG_DAYS, in chunks of at most MAX_REQUEST_DAYS, then one
 * Forecast API request for the rest. `to` may not be after today.
 */
export function planRequests(
  from: string,
  to: string,
  now: Date,
): WeatherRequest[] {
  if (!isUtcDay(from) || !isUtcDay(to)) {
    throw new RangeError('from and to must be days written as YYYY-MM-DD');
  }
  if (to < from) throw new RangeError('to must not be before from');
  const today = utcDay(now);
  if (to > today) throw new RangeError(`to must not be after today (${today})`);

  const firstForecastDay = addDays(today, -HISTORICAL_LAG_DAYS);
  const requests: WeatherRequest[] = [];
  const historicalEnd =
    to < firstForecastDay ? to : addDays(firstForecastDay, -1);
  for (let start = from; start <= historicalEnd;) {
    const end =
      daysBetween(start, historicalEnd) < MAX_REQUEST_DAYS
        ? historicalEnd
        : addDays(start, MAX_REQUEST_DAYS - 1);
    requests.push({ api: 'historical', from: start, to: end });
    start = addDays(end, 1);
  }
  if (to >= firstForecastDay) {
    requests.push({
      api: 'forecast',
      from: from > firstForecastDay ? from : firstForecastDay,
      to,
    });
  }
  return requests;
}

/** Thrown for a failed request or a response that doesn't have the expected shape. */
export class OpenMeteoError extends Error {
  override readonly name = 'OpenMeteoError';
  constructor(
    message: string,
    /** HTTP status, when there was a response. */
    readonly status?: number,
    /** Worth retrying: 429, 5xx, network errors and timeouts. */
    readonly transient = false,
  ) {
    super(message);
  }
}

export interface FetchFarmWeatherOptions extends WeatherRequest {
  latitude: number;
  longitude: number;
  /** OPEN_METEO_API_KEY: uses the customer-* hosts (commercial use). */
  apiKey?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  timeoutMs?: number;
}

/**
 * Builds the request URL (exported for tests; never log it: it may carry the API key). The API key,
 * when given, switches to the paid customer-* host.
 */
export function buildOpenMeteoUrl(options: FetchFarmWeatherOptions): URL {
  const historical = options.api === 'historical';
  const host = `${options.apiKey ? 'customer-' : ''}${historical ? 'historical-forecast-api' : 'api'}.open-meteo.com`;
  const url = new URL(`https://${host}/v1/forecast`);
  const params = url.searchParams;
  params.set('latitude', String(options.latitude));
  params.set('longitude', String(options.longitude));
  params.set('start_date', options.from);
  params.set('end_date', options.to);
  params.set('minutely_15', WEATHER_VARIABLES.map((v) => v.api).join(','));
  params.set('timezone', 'UTC');
  params.set('wind_speed_unit', 'ms');
  params.set('timeformat', 'iso8601');
  if (options.apiKey) params.set('apikey', options.apiKey);
  return url;
}

/**
 * Fetches the 15-minute weather of one location for whole UTC days and aggregates it into 30-minute
 * buckets. Retries 429, 5xx, network errors and timeouts (OPEN_METEO_ATTEMPTS, backoff 1 s, 2 s);
 * any other status or a malformed body fails at once. Buckets without any value are dropped.
 */
export async function fetchFarmWeather(
  options: FetchFarmWeatherOptions,
): Promise<WeatherBucketRow[]> {
  const {
    fetch: fetchFn = fetch,
    sleep = (ms: number) => delay(ms),
    timeoutMs = OPEN_METEO_TIMEOUT_MS,
  } = options;
  const url = buildOpenMeteoUrl(options);
  const what = `${options.api} ${options.from}..${options.to}`;

  let lastError: OpenMeteoError | undefined;
  for (let attempt = 1; attempt <= OPEN_METEO_ATTEMPTS; attempt++) {
    if (attempt > 1) await sleep(OPEN_METEO_BACKOFF_MS * 2 ** (attempt - 2));
    let response: Response;
    try {
      response = await fetchFn(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { accept: 'application/json' },
      });
    } catch (error) {
      const timedOut =
        error instanceof Error &&
        (error.name === 'TimeoutError' || error.name === 'AbortError');
      lastError = new OpenMeteoError(
        `Open-Meteo ${what}: ${timedOut ? `no response within ${timeoutMs} ms` : `request failed (${(error as Error).message})`}`,
        undefined,
        true,
      );
      continue;
    }
    if (!response.ok) {
      const transient = response.status === 429 || response.status >= 500;
      lastError = new OpenMeteoError(
        `Open-Meteo ${what}: HTTP ${response.status}${await errorReason(response)}`,
        response.status,
        transient,
      );
      if (!transient) throw lastError;
      continue;
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new OpenMeteoError(`Open-Meteo ${what}: the body is not JSON`);
    }
    return toHalfHourBuckets(parseMinutely15(body, what));
  }
  throw lastError!;
}

/** Open-Meteo's error body is `{ error: true, reason }`. */
async function errorReason(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { reason?: unknown };
    return typeof body?.reason === 'string' ? ` (${body.reason})` : '';
  } catch {
    return '';
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * Validates an Open-Meteo response by hand (`minutely_15.time` and one array per variable, all the
 * same length, numbers or null, UTC times) and maps it to 15-minute value sets.
 */
export function parseMinutely15(
  body: unknown,
  what: string = 'response',
): WeatherSample[] {
  const fail = (problem: string) =>
    new OpenMeteoError(`Open-Meteo ${what}: unexpected response (${problem})`);
  if (!isObject(body) || !isObject(body.minutely_15)) {
    throw fail('no minutely_15 object');
  }
  if (body.utc_offset_seconds !== undefined && body.utc_offset_seconds !== 0) {
    throw fail('times are not UTC');
  }
  const series = body.minutely_15;
  const times = series.time;
  if (!Array.isArray(times)) throw fail('minutely_15.time is not an array');
  const columns = WEATHER_VARIABLES.map(({ api }) => {
    const values = series[api];
    if (!Array.isArray(values)) throw fail(`minutely_15.${api} is missing`);
    if (values.length !== times.length) {
      throw fail(
        `minutely_15.${api} has ${values.length} values for ${times.length} times`,
      );
    }
    for (const value of values) {
      if (
        value !== null &&
        (typeof value !== 'number' || !Number.isFinite(value))
      ) {
        throw fail(`minutely_15.${api} has a non-numeric value`);
      }
    }
    return values as (number | null)[];
  });

  return times.map((time, i) => {
    if (typeof time !== 'string' || !TIME_PATTERN.test(time)) {
      throw fail(`bad time ${JSON.stringify(time)}`);
    }
    const at = new Date(`${time}:00Z`);
    if (Number.isNaN(at.getTime()) || at.getUTCMinutes() % 15 !== 0) {
      throw fail(`bad time ${JSON.stringify(time)}`);
    }
    const sample = { time: at } as WeatherSample;
    WEATHER_VARIABLES.forEach(
      ({ field }, j) => (sample[field] = columns[j][i]),
    );
    return sample;
  });
}

const HALF_HOUR_MS = 30 * 60 * 1000;

/** Rounded to 2 decimals (means of doubles carry float noise). */
const round2 = (value: number) => Math.round(value * 100) / 100;

function aggregate(kind: WeatherAggregate, values: number[]): number | null {
  if (!values.length) return null;
  switch (kind) {
    case 'mean':
      return round2(values.reduce((a, b) => a + b, 0) / values.length);
    case 'max':
      return Math.max(...values);
    case 'sum':
      return round2(values.reduce((a, b) => a + b, 0));
    case 'direction': {
      const rad = values.map((v) => (v * Math.PI) / 180);
      const sin = rad.reduce((a, r) => a + Math.sin(r), 0);
      const cos = rad.reduce((a, r) => a + Math.cos(r), 0);
      // 359.999 rounds to 360, which is north: report it as 0.
      return round2(((Math.atan2(sin, cos) * 180) / Math.PI + 360) % 360) % 360;
    }
  }
}

/**
 * Aggregates 15-minute value sets into 30-minute UTC buckets starting at :00 and :30, oldest first:
 * per metric the mean (gusts: max, precipitation: sum, directions: vector mean) of the values
 * present; `samples` = the value sets with at least one value. Buckets without any value are
 * dropped.
 */
export function toHalfHourBuckets(
  samples: readonly WeatherSample[],
): WeatherBucketRow[] {
  const buckets = new Map<number, WeatherSample[]>();
  for (const sample of samples) {
    if (WEATHER_VARIABLES.every(({ field }) => sample[field] === null))
      continue;
    const start =
      Math.floor(sample.time.getTime() / HALF_HOUR_MS) * HALF_HOUR_MS;
    const bucket = buckets.get(start);
    if (bucket) bucket.push(sample);
    else buckets.set(start, [sample]);
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .map(([start, members]) => {
      const row = {
        time: new Date(start),
        samples: members.length,
      } as WeatherBucketRow;
      for (const { field, aggregate: kind } of WEATHER_VARIABLES) {
        row[field] = aggregate(
          kind,
          members.flatMap((m) => (m[field] === null ? [] : [m[field]])),
        );
      }
      return row;
    });
}
