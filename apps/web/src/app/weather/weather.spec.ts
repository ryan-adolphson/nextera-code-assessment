import { weatherSlot } from '../fleet/testing';
import {
  WEATHER_STEP_MS,
  expectedSamples,
  latestSlot,
  recentDays,
  slotPoints,
  slotRange,
  slotStart,
  weatherCharts,
  windOverlay,
} from './weather';

describe('weather helpers', () => {
  const t = (iso: string) => Date.parse(iso);

  it('slotStart: the start of the 30-minute UTC bucket', () => {
    expect(slotStart(t('2026-01-02T10:45:30.500Z'))).toBe(t('2026-01-02T10:30:00Z'));
    expect(slotStart(t('2026-01-02T10:30:00Z'))).toBe(t('2026-01-02T10:30:00Z'));
    expect(slotStart(t('2026-01-02T10:29:59Z'))).toBe(t('2026-01-02T10:00:00Z'));
  });

  it('slotRange: from the bucket of `from` to the end of the bucket of `to`', () => {
    expect(slotRange(t('2026-01-02T00:07:00Z'), t('2026-01-03T00:07:00Z'))).toEqual({
      from: '2026-01-02T00:00:00.000Z',
      to: '2026-01-03T00:30:00.000Z',
    });
  });

  it('recentDays: the last 7 days ending today, in the zone', () => {
    const now = t('2026-01-03T03:00:00Z'); // Jan 2, 21:00 in Chicago
    expect(recentDays(now, 'UTC')).toEqual({
      from: '2025-12-28T00:00:00.000Z',
      to: '2026-01-04T00:00:00.000Z',
    });
    expect(recentDays(now, 'America/Chicago')).toEqual({
      from: '2025-12-27T06:00:00.000Z',
      to: '2026-01-03T06:00:00.000Z',
    });
  });

  it('expectedSamples: 48 buckets a day, 46/50 on a DST day in the zone', () => {
    expect(expectedSamples('2026-03-08', 'UTC')).toBe(48);
    expect(expectedSamples('2026-03-08', 'America/Chicago')).toBe(46);
    expect(expectedSamples('2026-11-01', 'America/Chicago')).toBe(50);
  });

  it('latestSlot: the newest bucket that has started, in any order', () => {
    const slots = [
      weatherSlot({ time: '2026-01-02T23:00:00.000Z' }),
      weatherSlot({ time: '2026-01-03T00:30:00.000Z' }), // not yet started
      weatherSlot({ time: '2026-01-02T23:30:00.000Z' }),
      weatherSlot({ time: '2026-01-02T22:30:00.000Z' }),
    ];
    expect(latestSlot(slots, t('2026-01-03T00:10:00Z'))?.time).toBe('2026-01-02T23:30:00.000Z');
    expect(latestSlot([], t('2026-01-03T00:00:00Z'))).toBeNull();
  });

  it('slotPoints: ascending, without missing values', () => {
    const slots = [
      weatherSlot({ time: '2026-01-02T23:30:00.000Z', windSpeed80mMs: 9 }),
      weatherSlot({ time: '2026-01-02T23:00:00.000Z', windSpeed80mMs: null }),
      weatherSlot({ time: '2026-01-02T22:30:00.000Z', windSpeed80mMs: 8 }),
    ];
    expect(slotPoints(slots, 'windSpeed80mMs')).toEqual([
      { t: t('2026-01-02T22:30:00Z'), v: 8 },
      { t: t('2026-01-02T23:30:00Z'), v: 9 },
    ]);
  });

  it('windOverlay: the 80 m wind, or null without a value', () => {
    expect(windOverlay([weatherSlot({ windSpeed80mMs: null })])).toBeNull();
    expect(windOverlay([weatherSlot()])).toEqual({
      label: 'Open-Meteo 80 m (farm)',
      points: [{ t: t('2026-01-02T23:30:00Z'), v: 9.4 }],
      stepMs: WEATHER_STEP_MS,
    });
  });

  it('weatherCharts: temperature, gusts and precipitation as lines on 30-minute steps', () => {
    const charts = weatherCharts([weatherSlot()]);
    expect(charts.map((c) => [c.key, c.unit, c.kind, c.points[0].v])).toEqual([
      ['weather-temperature', '°C', 'line', -1.5],
      ['weather-gusts', 'm/s', 'line', 12.5],
      ['weather-precipitation', 'mm', 'line', 0.2],
    ]);
    expect(charts[0].gapMs).toBe(WEATHER_STEP_MS * 1.5);
  });
});
