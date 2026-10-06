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

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const TIME_STEPS = [
  15 * MINUTE,
  30 * MINUTE,
  HOUR,
  2 * HOUR,
  3 * HOUR,
  6 * HOUR,
  12 * HOUR,
  DAY,
  2 * DAY,
];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export interface TimeTick {
  t: number;
  label: string;
}

/**
 * UTC-aligned time ticks spaced at least `minSpacingPx` apart: "HH:mm", or "MMM d" at midnight,
 * so a multi-day range shows where each day starts.
 */
export function timeTicks(
  from: number,
  to: number,
  widthPx: number,
  minSpacingPx = 80,
): TimeTick[] {
  const maxTicks = Math.max(1, Math.floor(widthPx / minSpacingPx));
  const step = TIME_STEPS.find((s) => (to - from) / s <= maxTicks) ?? TIME_STEPS.at(-1)!;
  const ticks: TimeTick[] = [];
  for (let t = Math.ceil(from / step) * step; t <= to; t += step) {
    ticks.push({ t, label: formatTick(t) });
  }
  return ticks;
}

function formatTick(t: number): string {
  const d = new Date(t);
  if (t % DAY === 0) return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`;
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function formatTimestamp(t: number): string {
  const d = new Date(t);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
}

const pad = (n: number) => String(n).padStart(2, '0');

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
