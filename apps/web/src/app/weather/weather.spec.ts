import { weatherSlot } from '../fleet/testing';
import {
  expectedSamples,
  latestSlot,
  recentDays,
  slotPoints,
  slotRange,
  slotStart,
  weatherDays,
  weatherHistoryCharts,
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

  it('weatherDays: the first and last of the last 7 days (midnights in the zone)', () => {
    const now = t('2026-01-03T03:00:00Z'); // Jan 2, 21:00 in Chicago
    expect(weatherDays(now, 'UTC')).toEqual({
      start: t('2025-12-28T00:00:00Z'),
      end: t('2026-01-03T00:00:00Z'),
    });
    expect(weatherDays(now, 'America/Chicago')).toEqual({
      start: t('2025-12-27T06:00:00Z'),
      end: t('2026-01-02T06:00:00Z'),
    });
  });

  it('slotPoints: one metric, ascending, without missing values', () => {
    const slots = [
      weatherSlot({ time: '2026-01-02T01:00:00.000Z', temperature2mC: 2 }),
      weatherSlot({ time: '2026-01-02T00:00:00.000Z', temperature2mC: 1 }),
      weatherSlot({ time: '2026-01-02T00:30:00.000Z', temperature2mC: null }),
    ];
    expect(slotPoints(slots, 'temperature2mC')).toEqual([
      { t: t('2026-01-02T00:00:00Z'), v: 1 },
      { t: t('2026-01-02T01:00:00Z'), v: 2 },
    ]);
  });

  it('weatherHistoryCharts: a line chart per metric, in order', () => {
    const charts = weatherHistoryCharts([weatherSlot({ time: '2026-01-02T00:00:00.000Z' })]);
    expect(charts.map((c) => [c.key, c.unit, c.decimals, c.points.map((p) => p.v)])).toEqual([
      ['wind-80m', 'm/s', 1, [9.4]],
      ['wind-10m', 'm/s', 1, [6]],
      ['gusts', 'm/s', 1, [12.5]],
      ['temperature', '°C', 1, [-1.5]],
      ['precipitation', 'mm', 1, [0.2]],
      ['humidity', '%', 0, [80]],
      ['pressure', 'hPa', 0, [990]],
      ['cloud-cover', '%', 0, [75]],
    ]);
  });
});
