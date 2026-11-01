import { UTC_ZONE, formatIn, zoneAbbr } from '../core/time-zone';
import { Candle, formatTimestamp } from './scales';

/**
 * Tooltip: the value (bold, text ink) first, then the time (in the zone shown), then any marker lines (e.g. the
 * alerts that fired). Text only, never HTML.
 */
export function tooltipContent(
  value: string,
  t: number,
  lines: readonly string[] = [],
  zone: string = UTC_ZONE,
): HTMLElement {
  const root = document.createElement('div');
  root.className = 'text-xs leading-5';
  const strong = document.createElement('strong');
  strong.className = 'block text-ink';
  strong.textContent = value;
  const time = document.createElement('span');
  time.className = 'text-muted';
  time.textContent = formatTimestamp(t, zone);
  root.append(strong, time);
  for (const line of lines) {
    const item = document.createElement('span');
    item.className = 'block text-ink';
    item.textContent = line;
    root.append(item);
  }
  return root;
}

/** "Jan 2, 03:00–03:30 UTC" (or "… CST" in local time): a candle's time span. */
export function candleSpan(c: Candle, zone: string = UTC_ZONE): string {
  const start = formatIn(c.start, 'MMM d, HH:mm', zone);
  return `${start}–${formatIn(c.end, 'HH:mm', zone)} ${zoneAbbr(zone, c.start)}`;
}

/**
 * Candle tooltip: start/end (the open/close: first and last reading of the period), low and high (text ink, aligned figures) with the unit, then the time
 * span and the number of readings. Text only, never HTML.
 */
export function candleTooltip(
  c: Candle,
  format: (key: 'open' | 'close' | 'low' | 'high') => string,
  unit: string,
  zone: string = UTC_ZONE,
): HTMLElement {
  const root = document.createElement('div');
  root.className = 'text-xs leading-5';
  for (const [key, label] of [
    ['open', 'Start'],
    ['close', 'End'],
    ['low', 'Low'],
    ['high', 'High'],
  ] as const) {
    const row = document.createElement('span');
    row.className = 'flex justify-between gap-3 text-ink tabular-nums';
    const name = document.createElement('span');
    name.className = 'text-muted';
    name.textContent = label;
    const value = document.createElement('strong');
    value.textContent = `${format(key)} ${unit}`.trim();
    row.append(name, value);
    root.append(row);
  }
  const time = document.createElement('span');
  time.className = 'block text-muted';
  time.textContent = `${candleSpan(c, zone)} · ${c.count} ${c.count === 1 ? 'reading' : 'readings'}`;
  root.append(time);
  return root;
}
