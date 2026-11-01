import { candleSpan, candleTooltip, tooltipContent } from './chart-tooltips';
import { Candle } from './scales';

const MIN = 60_000;
const start = Date.parse('2026-01-02T03:00:00.000Z');
const candle = (count: number): Candle => ({
  t: start + 15 * MIN,
  start,
  end: start + 30 * MIN,
  open: 82.1,
  close: 90,
  low: 81.9,
  high: 126.5,
  count,
});
const format = (c: Candle) => (key: 'open' | 'close' | 'low' | 'high') => c[key].toFixed(1);
const lines = (el: HTMLElement) => [...el.children].map((child) => child.textContent);

describe('candleTooltip', () => {
  it('lists start, end, low and high with the unit, then the span and the reading count', () => {
    const c = candle(4);
    expect(lines(candleTooltip(c, format(c), '°C'))).toEqual([
      'Start82.1 °C',
      'End90.0 °C',
      'Low81.9 °C',
      'High126.5 °C',
      'Jan 2, 03:00–03:30 UTC · 4 readings',
    ]);
  });

  it('says "1 reading" for a single reading', () => {
    const c = candle(1);
    expect(lines(candleTooltip(c, format(c), '°C')).at(-1)).toBe(
      'Jan 2, 03:00–03:30 UTC · 1 reading',
    );
  });

  it('omits the unit cleanly when there is none', () => {
    const c = candle(2);
    expect(lines(candleTooltip(c, format(c), ''))[0]).toBe('Start82.1');
  });

  it('builds text only, never HTML', () => {
    const c = candle(2);
    const el = candleTooltip(c, () => '<img src=x onerror=alert(1)>', '');
    expect(el.querySelector('img')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror=alert(1)>');
  });
});

describe('in local time', () => {
  it('shows the candle span and the reading time in the zone, with its name', () => {
    const c = candle(2);
    expect(lines(candleTooltip(c, format(c), '°C', 'America/Chicago')).at(-1)).toBe(
      'Jan 1, 21:00–21:30 CST · 2 readings',
    );
    expect(candleSpan(c, 'Asia/Kolkata')).toBe('Jan 2, 08:30–09:00 GMT+5:30');
    const tip = tooltipContent('80.0 °C', start, ['Error: …'], 'America/Chicago');
    expect(lines(tip)).toEqual(['80.0 °C', 'Jan 1, 21:00 CST', 'Error: …']);
  });
});
