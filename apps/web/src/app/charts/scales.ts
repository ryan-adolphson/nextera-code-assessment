import { hoursToMilliseconds, minutesToMilliseconds, setHours, startOfDay } from 'date-fns';
import { millisecondsInDay, millisecondsInHour, millisecondsInMinute } from 'date-fns/constants';
import { UTC_ZONE, formatIn, zoneContext, zoneOffsetMs } from '../core/time-zone';

export interface ChartPoint {
  /** Epoch milliseconds. */
  t: number;
  v: number;
}

/** The nearest "nice" step (1, 2 or 5 × 10ⁿ) to `value`. */
function niceStep(value: number): number {
  const exponent = Math.floor(Math.log10(value));
  const fraction = value / 10 ** exponent;
  const nice = fraction < 1.5 ? 1 : fraction < 3 ? 2 : fraction < 7 ? 5 : 10;
  return nice * 10 ** exponent;
}

/**
 * Tick steps, finest first: 15 and 30 minutes, 1, 2, 3, 6, 12, 24 and 48 hours, then 4, 7, 14 and
 * 28 days (months of daily candles). Day steps are whole wall-clock days, so they stay on midnight.
 */
const TIME_STEPS = [
  minutesToMilliseconds(15),
  minutesToMilliseconds(30),
  ...[1, 2, 3, 6, 12, 24, 48].map(hoursToMilliseconds),
  ...[4, 7, 14, 28].map((days) => days * millisecondsInDay),
];

export interface TimeTick {
  t: number;
  label: string;
}

/** `n` mod `m`, never negative. */
function mod(n: number, m: number): number {
  return ((n % m) + m) % m;
}

/** The wall-clock time at instant `t` in `zone`, as ms since the zone's 1970-01-01 00:00. */
function wallTime(t: number, zone: string): number {
  return t + zoneOffsetMs(zone, t);
}

/**
 * Time ticks aligned in `zone` (UTC by default), spaced at least `minSpacingPx` apart: "HH:mm", or
 * "MMM d" at the zone's midnight, so a multi-day range shows where each day starts. A tick is an
 * instant whose wall-clock time is a multiple of the step, so across a DST change the ticks follow
 * the clock (e.g. 00:00, 01:00, 03:00 on a spring-forward day) and a +5:30 zone gets its own hours.
 */
export function timeTicks(
  from: number,
  to: number,
  widthPx: number,
  minSpacingPx = 80,
  zone: string = UTC_ZONE,
): TimeTick[] {
  const maxTicks = Math.max(1, Math.floor(widthPx / minSpacingPx));
  const step = TIME_STEPS.find((s) => (to - from) / s <= maxTicks) ?? TIME_STEPS.at(-1)!;
  const onStep = (t: number) => mod(wallTime(t, zone), step) === 0;
  // Every zone's offset is a whole number of quarter hours, so each tick is on the absolute
  // 15-minute grid: scan it for the first one, then step (scanning again past a DST change).
  const grid = TIME_STEPS[0];
  const nextTick = (after: number) => {
    let t = after;
    while (t <= to && !onStep(t)) t += grid;
    return t;
  };
  const ticks: TimeTick[] = [];
  for (let t = nextTick(Math.ceil(from / grid) * grid); t <= to;) {
    ticks.push({ t, label: formatTick(t, zone) });
    t = onStep(t + step) ? t + step : nextTick(t + grid);
  }
  return ticks;
}

/** "HH:mm", or "MMM d" at midnight in `zone`. */
function formatTick(t: number, zone: string): string {
  return formatIn(t, mod(wallTime(t, zone), millisecondsInDay) === 0 ? 'MMM d' : 'HH:mm', zone);
}

/** "Jan 2, 03:20 UTC" (or "Jan 1, 21:20 CST" in local time): a time as the charts show it. */
export function formatTimestamp(t: number, zone: string = UTC_ZONE): string {
  return formatIn(t, 'MMM d, HH:mm', zone, true);
}

/** Index of the point nearest to `t` (points ascending by t), or -1 if there are none. */
export function nearestIndex(points: ChartPoint[], t: number): number {
  if (!points.length) return -1;
  let lo = 0;
  let hi = points.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  if (lo > 0 && t - points[lo - 1].t < points[lo].t - t) return lo - 1;
  return lo;
}

/** A chart point; `y: null` breaks the line. */
export interface XYPoint {
  x: number;
  y: number | null;
}

/**
 * Line data for a series: points in time order with a `null` inserted wherever two readings
 * are more than `gapMs` apart, so (with spanGaps off) missing readings break the line.
 */
export function withGapBreaks(points: ChartPoint[], gapMs: number): XYPoint[] {
  const data: XYPoint[] = [];
  points.forEach((p, i) => {
    const prev = points[i - 1];
    if (prev && p.t - prev.t > gapMs) data.push({ x: (prev.t + p.t) / 2, y: null });
    data.push({ x: p.t, y: p.v });
  });
  return data;
}

/** Whether data[index] has no connected neighbour (so it would be invisible as a line). */
export function isIsolated(data: XYPoint[], index: number): boolean {
  return data[index]?.y != null && data[index - 1]?.y == null && data[index + 1]?.y == null;
}

/**
 * The value range plus `fraction` of it on each side (the chart's zoomed-out view and zoom limit).
 * Not padded below 0 when no value is negative (power, wind, rpm can't go negative).
 * A flat series is padded by `fraction` of its value (or 1) so it still has a visible range.
 */
export function paddedRange(
  min: number,
  max: number,
  fraction = 0.1,
): { min: number; max: number } {
  const span = max - min || Math.abs(max) || 1;
  const pad = span * fraction;
  return { min: min >= 0 ? Math.max(0, min - pad) : min - pad, max: max + pad };
}

/**
 * Round tick values (multiples of 1, 2 or 5 × 10ⁿ) inside fixed bounds, about `count` intervals
 * apart. The bounds stay as given (e.g. padded or zoomed).
 */
export function ticksWithin(min: number, max: number, count = 4): number[] {
  if (!(max > min)) return [];
  const step = niceStep((max - min) / count);
  const ticks: number[] = [];
  for (let v = Math.ceil(min / step) * step; v <= max + step * 1e-9; v += step) {
    ticks.push(Number(v.toFixed(10)));
  }
  return ticks;
}

/** One candle: a metric over a time bucket [start, end), drawn at the bucket centre `t`. */
export interface Candle {
  /** Bucket centre (epoch ms): where the candle is drawn and the crosshair snaps. */
  t: number;
  start: number;
  end: number;
  /** First and last reading in the bucket, and the extremes. */
  open: number;
  close: number;
  low: number;
  high: number;
  /** Readings in the bucket. */
  count: number;
  /**
   * Precomputed candles (e.g. one per day from the API): the period's name, replacing the time
   * span ("Sat, Jan 3, 2026"), and what to say instead of "N readings" ("2 of 2 turbines reporting").
   */
  label?: string;
  detail?: string;
}

/**
 * Candle size for a time range, about 24–48 candles per chart: up to 6 h → 15 min, up to 24 h →
 * 30 min, up to 48 h → 1 h, longer → 4 h.
 */
export function candleSizeFor(spanMs: number): number {
  if (spanMs <= hoursToMilliseconds(6)) return minutesToMilliseconds(15);
  if (spanMs <= hoursToMilliseconds(24)) return minutesToMilliseconds(30);
  if (spanMs <= hoursToMilliseconds(48)) return hoursToMilliseconds(1);
  return hoursToMilliseconds(4);
}

/**
 * The candle bucket [start, end) of `sizeMs` holding instant `t`, aligned to the wall clock in
 * `zone`. Up to an hour: whole minutes past the zone's hour (absolute length, so the repeated hour
 * of an autumn DST change gets its own candles). Longer (4 h): hours of the zone's calendar day
 * through date-fns in the zone's context, so a bucket across a DST change is 3 or 5 hours long.
 */
function bucketOf(t: number, sizeMs: number, zone: string): { start: number; end: number } {
  if (sizeMs <= millisecondsInHour) {
    const start = t - mod(wallTime(t, zone), sizeMs);
    return { start, end: start + sizeMs };
  }
  const ctx = zoneContext(zone);
  const hours = sizeMs / millisecondsInHour;
  const day = startOfDay(t, { in: ctx });
  const first = Math.floor(ctx(t).getHours() / hours) * hours;
  return { start: +setHours(day, first), end: +setHours(day, first + hours) };
}

/**
 * Readings (ascending by t) as candles of `sizeMs` aligned in `zone` (UTC by default). Buckets
 * without readings get no candle, so gaps stay visible.
 */
export function toCandles(
  points: readonly ChartPoint[],
  sizeMs: number,
  zone: string = UTC_ZONE,
): Candle[] {
  const candles: Candle[] = [];
  for (const p of points) {
    const last = candles.at(-1);
    if (last && p.t >= last.start && p.t < last.end) {
      last.close = p.v;
      last.low = Math.min(last.low, p.v);
      last.high = Math.max(last.high, p.v);
      last.count++;
    } else {
      const { start, end } = bucketOf(p.t, sizeMs, zone);
      candles.push({
        t: (start + end) / 2,
        start,
        end,
        open: p.v,
        close: p.v,
        low: p.v,
        high: p.v,
        count: 1,
      });
    }
  }
  return candles;
}

/** "15 min", "1 h", "4 h": a candle size in words. */
export function formatDuration(ms: number): string {
  return ms < millisecondsInHour
    ? `${ms / millisecondsInMinute} min`
    : `${ms / millisecondsInHour} h`;
}
