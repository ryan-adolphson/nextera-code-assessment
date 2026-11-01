import type { Page, Request, Route } from '@playwright/test';

/**
 * Weather mocks for the browser tests: response bodies in the API's shape (GET /api/farms/:id/weather,
 * see apps/web/src/app/weather/weather.model.ts; the farm Overview and its Weather history tab) and route
 * helpers. The db:seed fixture has no weather (the sync only covers recent days), so populated
 * views are tested with these deterministic bodies, built from the request's own from/to/timeZone.
 */

const SLOT_MS = 30 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

export interface WeatherSlot {
  time: string;
  samples: number;
  windSpeed10mMs: number | null;
  windSpeed80mMs: number | null;
  windDirection10mDeg: number | null;
  windDirection80mDeg: number | null;
  windGusts10mMs: number | null;
  temperature2mC: number | null;
  relativeHumidity2mPct: number | null;
  surfacePressureHpa: number | null;
  precipitationMm: number | null;
  cloudCoverPct: number | null;
}

export interface WeatherDay {
  date: string;
  samples: number;
  windSpeed10mMeanMs: number | null;
  windSpeed10mMaxMs: number | null;
  windSpeed80mMeanMs: number | null;
  windSpeed80mMaxMs: number | null;
  windDirection80mDeg: number | null;
  windGusts10mMaxMs: number | null;
  temperature2mMinC: number | null;
  temperature2mMaxC: number | null;
  temperature2mMeanC: number | null;
  relativeHumidity2mMeanPct: number | null;
  surfacePressureMeanHpa: number | null;
  precipitationSumMm: number | null;
  cloudCoverMeanPct: number | null;
}

/**
 * The 30-minute bucket starting at `t` (epoch ms): values vary with the half hour of the day, in
 * steps of 0.5 so the one-decimal text in the UI is exact (no rounding in the expectations).
 */
export function slotAt(t: number): WeatherSlot {
  const h = Math.floor((t % DAY_MS) / SLOT_MS); // 0..47
  return {
    time: new Date(t).toISOString(),
    samples: 2,
    windSpeed10mMs: 4 + (h % 8) * 0.5,
    windSpeed80mMs: 6 + (h % 10) * 0.5,
    windDirection10mDeg: 200,
    windDirection80mDeg: 210,
    windGusts10mMs: 9 + (h % 6) * 0.5,
    temperature2mC: -4 + (h % 16) * 0.5,
    relativeHumidity2mPct: 70,
    surfacePressureHpa: 1012.5,
    precipitationMm: h % 4 === 0 ? 0.5 : 0,
    cloudCoverPct: 40,
  };
}

/** The buckets in [from, to) (the API answers whole :00/:30 UTC buckets). */
export function slotsBetween(from: string, to: string): WeatherSlot[] {
  const slots: WeatherSlot[] = [];
  for (let t = Date.parse(from); t < Date.parse(to); t += SLOT_MS) slots.push(slotAt(t));
  return slots;
}

/** "2026-01-02": the calendar day of `t` in `zone`. */
export function dayIn(t: number, zone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(t));
}

/** The days in [from, to) of `zone` (no DST change in the fixture's weeks: 24 h each). */
export function daysBetween(
  from: string,
  to: string,
  zone: string,
  partialLastDay: number | null,
): WeatherDay[] {
  const start = Date.parse(from);
  const count = Math.round((Date.parse(to) - start) / DAY_MS);
  return Array.from({ length: count }, (_, i) => ({
    date: dayIn(start + i * DAY_MS + DAY_MS / 2, zone),
    samples: i === count - 1 && partialLastDay !== null ? partialLastDay : 48,
    windSpeed10mMeanMs: 4.5,
    windSpeed10mMaxMs: 7.5,
    windSpeed80mMeanMs: 6 + i * 0.5,
    windSpeed80mMaxMs: 10 + i * 0.5,
    windDirection80mDeg: 215,
    windGusts10mMaxMs: 14,
    temperature2mMinC: -6 + i * 0.5,
    temperature2mMaxC: 3 + i * 0.5,
    temperature2mMeanC: -1.5,
    relativeHumidity2mMeanPct: 72,
    surfacePressureMeanHpa: 1013,
    precipitationSumMm: i % 3 === 0 ? 1.5 : 0,
    cloudCoverMeanPct: 55,
  }));
}

export type Interval = '30min' | 'daily';

/** The query of a weather request. */
export function weatherQuery(request: Request) {
  const params = new URL(request.url()).searchParams;
  return {
    from: params.get('from')!,
    to: params.get('to')!,
    interval: (params.get('interval') ?? '30min') as Interval,
    timeZone: params.get('timeZone'),
  };
}

const FARM_WEATHER = /\/api\/farms\/([^/]+)\/weather$/;

export const isFarmWeather = (url: URL) => FARM_WEATHER.test(url.pathname);

/** True for a farm weather request of `interval`. */
export function isWeatherRequest(request: Request, interval?: Interval): boolean {
  const url = new URL(request.url());
  if (!isFarmWeather(url)) return false;
  return !interval || weatherQuery(request).interval === interval;
}

/** Options for the mocked bodies (all optional; the defaults answer every bucket/day asked for). */
export interface WeatherMockOptions {
  /** Daily: the samples of the last day (a partial today), else 48. */
  partialLastDay?: number | null;
  /** 30-minute: answer only the buckets that have started by this time (epoch ms), as the API would. */
  until?: number;
  /** 30-minute: bucket start times (ISO) left out of the answer (a missing bucket). */
  missing?: readonly string[];
}

/** A 200 in the API's shape for the request: 30-minute buckets or days, with the echoed query. */
export async function fulfillWeather(route: Route, options: WeatherMockOptions = {}): Promise<void> {
  const request = route.request();
  const url = new URL(request.url());
  const { from, to, interval, timeZone } = weatherQuery(request);
  const zone = timeZone ?? 'UTC';
  const farm = FARM_WEATHER.exec(url.pathname);
  const body = {
    farmId: farm ? decodeURIComponent(farm[1]) : 'FARM01',
    from,
    to,
    interval,
    timeZone: zone,
    points:
      interval === 'daily'
        ? daysBetween(from, to, zone, options.partialLastDay ?? null)
        : slotsBetween(from, to).filter(
            (slot) =>
              (options.until === undefined || Date.parse(slot.time) <= options.until) &&
              !options.missing?.includes(slot.time),
          ),
  };
  await route.fulfill({ status: 200, json: body });
}

/** A 500 as the API answers an unexpected failure. */
export async function failWeather(route: Route): Promise<void> {
  await route.fulfill({
    status: 500,
    json: { statusCode: 500, message: 'Internal server error' },
  });
}

/**
 * Routes every farm weather request: `fail()` decides per request whether to answer
 * 500 (so a test can switch the API back to healthy before Retry). Resolves the requests seen.
 */
export async function mockWeather(
  page: Page,
  options: WeatherMockOptions & { fail?: () => boolean } = {},
): Promise<Request[]> {
  const seen: Request[] = [];
  await page.route(
    (url) => isFarmWeather(url),
    async (route) => {
      seen.push(route.request());
      if (options.fail?.()) await failWeather(route);
      else await fulfillWeather(route, options);
    },
  );
  return seen;
}

/** One decimal, as the UI shows values (en-US). */
export const oneDecimal = (v: number) =>
  v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
