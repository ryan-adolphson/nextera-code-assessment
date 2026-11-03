import { TestBed } from '@angular/core/testing';
import { NOW } from '../core/clock';
import { FARM_HISTORY_FRESH_MS, FarmHistoryCache, FarmHistoryKey } from './farm-history-cache';
import { FarmDailyDay, FarmDailyHistory } from './farm-history.model';
import { FARM_HISTORY_RANGES, daySpan, lastDays, powerCandles } from './farm-history';

const H = 3_600_000;
const iso = (t: number) => new Date(t).toISOString();

describe('lastDays', () => {
  it('is whole UTC days ending today, today included', () => {
    expect(lastDays(Date.parse('2026-01-03T23:59:00Z'), 30, 'UTC')).toEqual({
      from: '2025-12-05T00:00:00.000Z',
      to: '2026-01-04T00:00:00.000Z',
    });
  });

  it('is whole local days, so a range across a DST change is an hour longer or shorter', () => {
    // Today (Nov 1) is the 25-hour fall-back day in Chicago.
    const autumn = lastDays(Date.parse('2026-11-01T18:00:00Z'), 30, 'America/Chicago');
    expect(autumn).toEqual({ from: '2026-10-03T05:00:00.000Z', to: '2026-11-02T06:00:00.000Z' });
    expect(Date.parse(autumn.to) - Date.parse(autumn.from)).toBe((30 * 24 + 1) * H);
    // The 6-month preset stays inside the API's 183 days even with that extra hour.
    const half = lastDays(Date.parse('2026-11-01T18:00:00Z'), 182, 'America/Chicago');
    expect(Date.parse(half.to) - Date.parse(half.from)).toBeLessThanOrEqual(183 * 24 * H);
    expect(FARM_HISTORY_RANGES.map((r) => [r.id, r.days])).toEqual([
      ['30d', 30],
      ['90d', 90],
      ['6m', 182],
    ]);
  });
});

describe('daySpan', () => {
  it('spans the local day: 24 h, 23 h in spring, 25 h in autumn, and +5:30 zones', () => {
    const span = (date: string, zone: string) => {
      const { start, end } = daySpan(date, zone);
      return [iso(start), (end - start) / H];
    };
    expect(span('2026-01-02', 'UTC')).toEqual(['2026-01-02T00:00:00.000Z', 24]);
    expect(span('2026-03-08', 'America/Chicago')).toEqual(['2026-03-08T06:00:00.000Z', 23]);
    expect(span('2026-11-01', 'America/Chicago')).toEqual(['2026-11-01T05:00:00.000Z', 25]);
    expect(span('2026-01-02', 'Asia/Kolkata')).toEqual(['2026-01-01T18:30:00.000Z', 24]);
  });
});

describe('powerCandles', () => {
  const ohlc = { open: 1, close: 2, low: 0, high: 3 };
  const day = (date: string, turbines: number): FarmDailyDay => ({
    date,
    turbines,
    readings: 12,
    powerOutputKw: { open: 100, close: 200, low: 50, high: 300 },
    windSpeedMs: ohlc,
    rotorRpm: ohlc,
    bladePitchDeg: ohlc,
    gearboxTempC: ohlc,
  });

  it('makes one power candle per day, centred on its local day, named by date and turbines', () => {
    const [candle] = powerCandles([day('2026-03-08', 1)], 1, 'America/Chicago');
    expect(candle).toEqual({
      t: Date.parse('2026-03-08T06:00:00Z') + 11.5 * H, // the middle of a 23-hour day
      start: Date.parse('2026-03-08T06:00:00Z'),
      end: Date.parse('2026-03-09T05:00:00Z'),
      open: 100,
      close: 200,
      low: 50,
      high: 300,
      count: 12,
      label: 'Sun, Mar 8, 2026',
      detail: '1 of 1 turbine reporting',
    });
    expect(powerCandles([day('2026-01-02', 2)], 3, 'UTC')[0].detail).toBe(
      '2 of 3 turbines reporting',
    );
  });
});

describe('FarmHistoryCache', () => {
  let now: number;
  let cache: FarmHistoryCache;
  const key = (overrides: Partial<FarmHistoryKey> = {}): FarmHistoryKey => ({
    farmId: 'FARM01',
    range: '30d',
    zone: 'UTC',
    from: '2025-12-05T00:00:00.000Z',
    to: '2026-01-04T00:00:00.000Z',
    ...overrides,
  });
  const history = { farmId: 'FARM01' } as FarmDailyHistory;

  beforeEach(() => {
    now = Date.parse('2026-01-03T00:00:00Z');
    TestBed.configureTestingModule({
      providers: [FarmHistoryCache, { provide: NOW, useValue: () => now }],
    });
    cache = TestBed.inject(FarmHistoryCache);
  });

  it('answers the same farm, range and zone for 15 minutes', () => {
    expect(cache.get(key())).toBeNull();
    cache.set(key(), history);
    expect(cache.get(key())).toBe(history);
    now += FARM_HISTORY_FRESH_MS - 1;
    expect(cache.get(key())).toBe(history);
    now += 1;
    expect(cache.get(key())).toBeNull();
  });

  it('misses another farm, range, zone, or other days (the range moved on at midnight)', () => {
    cache.set(key(), history);
    expect(cache.get(key({ farmId: 'FARM02' }))).toBeNull();
    expect(cache.get(key({ range: '90d' }))).toBeNull();
    expect(cache.get(key({ zone: 'America/Chicago' }))).toBeNull();
    expect(cache.get(key({ from: '2025-12-06T00:00:00.000Z' }))).toBeNull();
    expect(cache.get(key({ to: '2026-01-05T00:00:00.000Z' }))).toBeNull();
  });
});
