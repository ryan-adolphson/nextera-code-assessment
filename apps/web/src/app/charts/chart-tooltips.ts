import { Candle, formatTimestamp } from './scales';

/**
 * Tooltip: the value (bold, text ink) first, then the UTC time, then any marker lines (e.g. the
 * alerts that fired). Text only, never HTML.
 */
export function tooltipContent(
  value: string,
  t: number,
  lines: readonly string[] = [],
): HTMLElement {
  const root = document.createElement('div');
  root.className = 'text-xs leading-5';
  const strong = document.createElement('strong');
  strong.className = 'block text-ink';
  strong.textContent = value;
  const time = document.createElement('span');
  time.className = 'text-muted';
  time.textContent = formatTimestamp(t);
  root.append(strong, time);
  for (const line of lines) {
    const item = document.createElement('span');
    item.className = 'block text-ink';
    item.textContent = line;
    root.append(item);
  }
  return root;
}

/** "Jan 2, 03:00–03:30 UTC": a candle's time span. */
export function candleSpan(c: Candle): string {
  const end = formatTimestamp(c.end).replace(/^[A-Z][a-z]{2} \d{1,2}, /, '');
  return formatTimestamp(c.start).replace(' UTC', `–${end}`);
}

/**
 * Candle tooltip: start/end (the open/close: first and last reading of the period), low and high (text ink, aligned figures) with the unit, then the time
 * span and the number of readings. Text only, never HTML.
 */
export function candleTooltip(
  c: Candle,
  format: (key: 'open' | 'close' | 'low' | 'high') => string,
  unit: string,
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
  time.textContent = `${candleSpan(c)} · ${c.count} ${c.count === 1 ? 'reading' : 'readings'}`;
  root.append(time);
  return root;
}
