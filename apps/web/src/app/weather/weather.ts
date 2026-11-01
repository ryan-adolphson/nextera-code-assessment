import { utc } from '@date-fns/utc';
import {
  addDays,
  addMinutes,
  minutesToMilliseconds,
  roundToNearestMinutes,
  startOfDay,
  subDays,
} from 'date-fns';
import { ChartSeries } from '../charts/chart-group';
import { ChartOverlay } from '../charts/line-chart';
import { ChartPoint } from '../charts/scales';
import { dayRange, zoneDayOf } from '../core/days';
import { zoneContext } from '../core/time-zone';
import { WeatherDay, WeatherSlot } from './weather.model';

/** Open-Meteo data comes in 30-minute buckets (UTC, starting :00 and :30). */
export const WEATHER_STEP_MINUTES = 30;
export const WEATHER_STEP_MS = minutesToMilliseconds(WEATHER_STEP_MINUTES);
/** Days in the farm page's daily view: the last 7, ending today (in the zone shown). */
export const WEATHER_DAYS = 7;

/** The modelled wind on the turbine page's wind chart (a turbine shows its farm's weather). */
export const WIND_OVERLAY_LABEL = 'Open-Meteo 80 m (farm)';

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

/** The last `WEATHER_DAYS` days ending today, in `zone`, as the API's [from, to). */
export function recentDays(now: number, zone: string): { from: string; to: string } {
  const ctx = zoneContext(zone);
  const today = startOfDay(now, { in: ctx });
  return dayRange(+subDays(today, WEATHER_DAYS - 1, { in: ctx }), +today, zone);
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

/** The day `date` from the daily points, or null. */
export function dayOfWeather(days: readonly WeatherDay[], date: string): WeatherDay | null {
  return days.find((d) => d.date === date) ?? null;
}

type SlotMetric = keyof Omit<WeatherSlot, 'time' | 'samples'>;

/** One metric as chart points, ascending; missing values are left out (the line breaks there). */
export function slotPoints(slots: readonly WeatherSlot[], key: SlotMetric): ChartPoint[] {
  return slots
    .flatMap((slot) => {
      const v = slot[key];
      return v === null ? [] : [{ t: Date.parse(slot.time), v }];
    })
    .sort((a, b) => a.t - b.t);
}

/** The 80 m wind as an overlay of the measured wind chart, or null without any value. */
export function windOverlay(slots: readonly WeatherSlot[]): ChartOverlay | null {
  const points = slotPoints(slots, 'windSpeed80mMs');
  return points.length ? { label: WIND_OVERLAY_LABEL, points, stepMs: WEATHER_STEP_MS } : null;
}

/** The weather charts under the turbine's telemetry: temperature, gusts and precipitation. */
export function weatherCharts(slots: readonly WeatherSlot[]): ChartSeries[] {
  const chart = (key: string, title: string, unit: string, metric: SlotMetric): ChartSeries => ({
    key,
    title,
    unit,
    decimals: 1,
    points: slotPoints(slots, metric),
    kind: 'line',
    gapMs: WEATHER_STEP_MS * 1.5,
  });
  return [
    chart('weather-temperature', 'Temperature, 2 m (Open-Meteo)', '°C', 'temperature2mC'),
    chart('weather-gusts', 'Wind gusts, 10 m (Open-Meteo)', 'm/s', 'windGusts10mMs'),
    chart(
      'weather-precipitation',
      'Precipitation per 30 min (Open-Meteo)',
      'mm',
      'precipitationMm',
    ),
  ];
}
