import { utc } from '@date-fns/utc';
import {
  addDays,
  addMinutes,
  minutesToMilliseconds,
  roundToNearestMinutes,
  startOfDay,
  subDays,
} from 'date-fns';
import type { ChartSeries } from '../charts/chart-group';
import type { ChartPoint } from '../charts/scales';
import { dayRange, zoneDayOf } from '../core/days';
import { zoneContext } from '../core/time-zone';
import { WeatherSlot } from './weather.model';

/** Open-Meteo data comes in 30-minute buckets (UTC, starting :00 and :30). */
export const WEATHER_STEP_MINUTES = 30;
export const WEATHER_STEP_MS = minutesToMilliseconds(WEATHER_STEP_MINUTES);
/** Days in the farm page's daily view: the last 7, ending today (in the zone shown). */
export const WEATHER_DAYS = 7;

/** The start of the 30-minute UTC bucket containing `t` (epoch ms). */
export function slotStart(t: number): number {
  return +roundToNearestMinutes(t, {
    nearestTo: WEATHER_STEP_MINUTES,
    roundingMethod: 'floor',
    in: utc,
  });
}

/**
 * The buckets covering [from, to] (epoch ms) as the API's [from, to): from the bucket containing
 * `from` to the end of the bucket containing `to`. Aligned to buckets, so a window that slides
 * by a minute asks for the same range until it crosses a bucket boundary.
 */
export function slotRange(from: number, to: number): { from: string; to: string } {
  return {
    from: new Date(slotStart(from)).toISOString(),
    to: new Date(+addMinutes(slotStart(to), WEATHER_STEP_MINUTES)).toISOString(),
  };
}

/**
 * The last `WEATHER_DAYS` days ending today, in `zone`: their first and last day (midnights in
 * `zone`, epoch ms). The Weather history tab's default range.
 */
export function weatherDays(now: number, zone: string): { start: number; end: number } {
  const ctx = zoneContext(zone);
  const today = startOfDay(now, { in: ctx });
  return { start: +subDays(today, WEATHER_DAYS - 1, { in: ctx }), end: +today };
}

/** The last `WEATHER_DAYS` days ending today, in `zone`, as the API's [from, to). */
export function recentDays(now: number, zone: string): { from: string; to: string } {
  const { start, end } = weatherDays(now, zone);
  return dayRange(start, end, zone);
}

/** 30-minute buckets in a calendar day ("2026-03-08") in `zone`: 48, or 46/50 on a DST day. */
export function expectedSamples(date: string, zone: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const start = zoneDayOf(new Date(y, m - 1, d), zone);
  const end = +addDays(start, 1, { in: zoneContext(zone) });
  return Math.round((end - start) / WEATHER_STEP_MS);
}

/** The newest bucket that has started by `now` (the API may return later ones), or null. */
export function latestSlot(slots: readonly WeatherSlot[], now: number): WeatherSlot | null {
  let latest: WeatherSlot | null = null;
  for (const slot of slots) {
    const t = Date.parse(slot.time);
    if (t <= now && (!latest || t > Date.parse(latest.time))) latest = slot;
  }
  return latest;
}

/** A metric of a 30-minute bucket. */
export type SlotMetric = keyof Omit<WeatherSlot, 'time' | 'samples'>;

/** One metric as chart points, ascending; missing values are left out (the line breaks there). */
export function slotPoints(slots: readonly WeatherSlot[], key: SlotMetric): ChartPoint[] {
  return slots
    .flatMap((slot) => {
      const v = slot[key];
      return v === null ? [] : [{ t: Date.parse(slot.time), v }];
    })
    .sort((a, b) => a.t - b.t);
}

/** The Weather history tab's charts, in order: one metric each. */
export const WEATHER_HISTORY_CHARTS: readonly {
  key: string;
  title: string;
  unit: string;
  decimals: number;
  metric: SlotMetric;
}[] = [
  {
    key: 'wind-80m',
    title: 'Wind speed, 80 m (mean)',
    unit: 'm/s',
    decimals: 1,
    metric: 'windSpeed80mMs',
  },
  {
    key: 'wind-10m',
    title: 'Wind speed, 10 m',
    unit: 'm/s',
    decimals: 1,
    metric: 'windSpeed10mMs',
  },
  { key: 'gusts', title: 'Wind gusts, 10 m', unit: 'm/s', decimals: 1, metric: 'windGusts10mMs' },
  {
    key: 'temperature',
    title: 'Temperature, 2 m',
    unit: '°C',
    decimals: 1,
    metric: 'temperature2mC',
  },
  {
    key: 'precipitation',
    title: 'Precipitation per 30 min',
    unit: 'mm',
    decimals: 1,
    metric: 'precipitationMm',
  },
  {
    key: 'humidity',
    title: 'Relative humidity, 2 m',
    unit: '%',
    decimals: 0,
    metric: 'relativeHumidity2mPct',
  },
  {
    key: 'pressure',
    title: 'Surface pressure',
    unit: 'hPa',
    decimals: 0,
    metric: 'surfacePressureHpa',
  },
  { key: 'cloud-cover', title: 'Cloud cover', unit: '%', decimals: 0, metric: 'cloudCoverPct' },
];

/** The Weather history charts for `slots` (a chart's points are empty when it has no values). */
export function weatherHistoryCharts(slots: readonly WeatherSlot[]): ChartSeries[] {
  return WEATHER_HISTORY_CHARTS.map(({ metric, ...chart }) => ({
    ...chart,
    points: slotPoints(slots, metric),
  }));
}
