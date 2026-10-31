import { setTimeout as delay } from 'node:timers/promises';
import type { WeatherSource } from '../generated/prisma/enums.js';

/**
 * Open-Meteo client for the farm weather dataset (hourly rows in farm_weather_hourly).
 *
 * - Days older than ARCHIVE_LAG_DAYS come from the Historical Weather API (ERA5 reanalysis, about
 *   5 days behind): `source = 'archive'`, final.
 * - More recent days (up to today) come from the Forecast API with start_date/end_date (it serves
 *   the last ~3 months of past days as well as the forecast): `source = 'forecast'`, replaced by
 *   the archive once it covers them.
 *
 * Licence: the free API is for non-commercial use only (about 10k calls a day). With an API key
 * the paid `customer-*` hosts are used with `&apikey=`.
 */

/** Days older than this many days (before today − 5, UTC) are read from the archive. */
export const ARCHIVE_LAG_DAYS = 5;
/** The widest single request (archive): longer ranges are split. */
export const MAX_REQUEST_DAYS = 366;
export const OPEN_METEO_TIMEOUT_MS = 15_000;
export const OPEN_METEO_ATTEMPTS = 3;
/** Backoff before the 2nd and 3rd attempt: 1 s, then 2 s. */
export const OPEN_METEO_BACKOFF_MS = 1_000;

/** Fields of an hour of weather (Prisma names of farm_weather_hourly's metric columns). */
export type WeatherMetric =
  | 'windSpeed10mMs'
  | 'windSpeed100mMs'
  | 'windDirection10mDeg'
  | 'windDirection100mDeg'
  | 'windGusts10mMs'
  | 'temperature2mC'
  | 'relativeHumidity2mPct'
  | 'surfacePressureHpa'
  | 'precipitationMm'
  | 'cloudCoverPct';

/**
 * Each stored metric: the Open-Meteo hourly variable (with `wind_speed_unit=ms`), the Prisma field
 * and the column. Fixed constants, so SQL built from `column` is safe.
 */
export const WEATHER_VARIABLES: readonly {
  api: string;
  field: WeatherMetric;
  column: string;
}[] = [
  {
    api: 'wind_speed_10m',
    field: 'windSpeed10mMs',
    column: 'wind_speed_10m_ms',
  },
  {
    api: 'wind_speed_100m',
    field: 'windSpeed100mMs',
    column: 'wind_speed_100m_ms',
  },
  {
    api: 'wind_direction_10m',
    field: 'windDirection10mDeg',
    column: 'wind_direction_10m_deg',
  },
  {
    api: 'wind_direction_100m',
    field: 'windDirection100mDeg',
    column: 'wind_direction_100m_deg',
  },
  {
    api: 'wind_gusts_10m',
    field: 'windGusts10mMs',
    column: 'wind_gusts_10m_ms',
  },
  {
    api: 'temperature_2m',
    field: 'temperature2mC',
    column: 'temperature_2m_c',
  },
  {
    api: 'relative_humidity_2m',
    field: 'relativeHumidity2mPct',
    column: 'relative_humidity_2m_pct',
  },
  {
    api: 'surface_pressure',
    field: 'surfacePressureHpa',
    column: 'surface_pressure_hpa',
  },
  {
    api: 'precipitation',
    field: 'precipitationMm',
    column: 'precipitation_mm',
  },
  { api: 'cloud_cover', field: 'cloudCoverPct', column: 'cloud_cover_pct' },
];

/** One hour of weather as stored (farm_weather_hourly without farm_id and fetched_at). */
export type WeatherHourRow = {
  /** Start of the UTC hour. */
  time: Date;
  source: WeatherSource;
} & Record<WeatherMetric, number | null>;

/** One Open-Meteo request: whole UTC days, `from`..`to` inclusive (YYYY-MM-DD). */
export interface WeatherRequest {
  source: WeatherSource;
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
 * Splits the UTC days `from`..`to` (inclusive) into Open-Meteo requests: archive for days before
 * today − ARCHIVE_LAG_DAYS, in chunks of at most MAX_REQUEST_DAYS, then one forecast request for the
 * rest. `to` may not be after today.
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

  const firstForecastDay = addDays(today, -ARCHIVE_LAG_DAYS);
  const requests: WeatherRequest[] = [];
  const archiveEnd = to < firstForecastDay ? to : addDays(firstForecastDay, -1);
  for (let start = from; start <= archiveEnd;) {
    const end =
      daysBetween(start, archiveEnd) < MAX_REQUEST_DAYS
        ? archiveEnd
        : addDays(start, MAX_REQUEST_DAYS - 1);
    requests.push({ source: 'archive', from: start, to: end });
    start = addDays(end, 1);
  }
  if (to >= firstForecastDay) {
    requests.push({
      source: 'forecast',
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
  const archive = options.source === 'archive';
  const host = `${options.apiKey ? 'customer-' : ''}${archive ? 'archive-api' : 'api'}.open-meteo.com`;
  const url = new URL(`https://${host}/v1/${archive ? 'archive' : 'forecast'}`);
  const params = url.searchParams;
  params.set('latitude', String(options.latitude));
  params.set('longitude', String(options.longitude));
  params.set('start_date', options.from);
  params.set('end_date', options.to);
  params.set('hourly', WEATHER_VARIABLES.map((v) => v.api).join(','));
  params.set('timezone', 'UTC');
  params.set('wind_speed_unit', 'ms');
  params.set('timeformat', 'iso8601');
  if (options.apiKey) params.set('apikey', options.apiKey);
  return url;
}

/**
 * Fetches the hourly weather of one location for whole UTC days and maps it to rows. Retries 429,
 * 5xx, network errors and timeouts (OPEN_METEO_ATTEMPTS, backoff 1 s, 2 s); any other status or a
 * malformed body fails at once. Hours with no value at all are dropped (an empty archive row would
 * otherwise block the forecast for that hour).
 */
export async function fetchFarmWeather(
  options: FetchFarmWeatherOptions,
): Promise<WeatherHourRow[]> {
  const {
    fetch: fetchFn = fetch,
    sleep = (ms: number) => delay(ms),
    timeoutMs = OPEN_METEO_TIMEOUT_MS,
  } = options;
  const url = buildOpenMeteoUrl(options);
  const what = `${options.source} ${options.from}..${options.to}`;

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
    return parseHourly(body, options.source, what);
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

const HOUR_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * Validates an Open-Meteo response by hand (`hourly.time` and one array per variable, all the same
 * length, numbers or null, UTC times) and maps it to rows.
 */
export function parseHourly(
  body: unknown,
  source: WeatherSource,
  what: string = source,
): WeatherHourRow[] {
  const fail = (problem: string) =>
    new OpenMeteoError(`Open-Meteo ${what}: unexpected response (${problem})`);
  if (!isObject(body) || !isObject(body.hourly)) throw fail('no hourly object');
  if (body.utc_offset_seconds !== undefined && body.utc_offset_seconds !== 0) {
    throw fail('times are not UTC');
  }
  const { hourly } = body;
  const times = hourly.time;
  if (!Array.isArray(times)) throw fail('hourly.time is not an array');
  const columns = WEATHER_VARIABLES.map(({ api }) => {
    const values = hourly[api];
    if (!Array.isArray(values)) throw fail(`hourly.${api} is missing`);
    if (values.length !== times.length) {
      throw fail(
        `hourly.${api} has ${values.length} values for ${times.length} times`,
      );
    }
    for (const value of values) {
      if (
        value !== null &&
        (typeof value !== 'number' || !Number.isFinite(value))
      ) {
        throw fail(`hourly.${api} has a non-numeric value`);
      }
    }
    return values as (number | null)[];
  });

  const rows: WeatherHourRow[] = [];
  times.forEach((time, i) => {
    if (typeof time !== 'string' || !HOUR_PATTERN.test(time)) {
      throw fail(`bad time ${JSON.stringify(time)}`);
    }
    const at = new Date(`${time}:00Z`);
    if (Number.isNaN(at.getTime()))
      throw fail(`bad time ${JSON.stringify(time)}`);
    const values = columns.map((column) => column[i]);
    if (values.every((value) => value === null)) return;
    const row = { time: at, source } as WeatherHourRow;
    WEATHER_VARIABLES.forEach(({ field }, j) => (row[field] = values[j]));
    rows.push(row);
  });
  return rows;
}
