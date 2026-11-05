import { TestBed } from '@angular/core/testing';
import { NOW } from '../core/clock';
import { FARM_HISTORY_FRESH_MS, FarmHistoryCache, FarmHistoryKey } from './farm-history-cache';
import { FarmDailyHistory } from './farm-history.model';

const T0 = Date.parse('2026-01-03T00:00:00.000Z');
const key: FarmHistoryKey = {
  farmId: 'FARM01',
  range: '30d',
  from: '2025-12-05T00:00:00.000Z',
  to: '2026-01-04T00:00:00.000Z',
  zone: 'UTC',
};
const history = (computedAt: string): FarmDailyHistory => ({
  farmId: 'FARM01',
  from: key.from,
  to: key.to,
  timeZone: 'UTC',
  turbineCount: 1,
  computedAt,
  days: [],
});

describe('FarmHistoryCache', () => {
  let now: number;
  let cache: FarmHistoryCache;
  beforeEach(() => {
    now = T0;
    TestBed.configureTestingModule({
      providers: [FarmHistoryCache, { provide: NOW, useValue: () => now }],
    });
    cache = TestBed.inject(FarmHistoryCache);
  });

  it('returns a fresh entry stored under the same rollup version', () => {
    const value = history('a');
    cache.set(key, value, 2);
    expect(cache.get(key, 2)).toBe(value);
  });

  it('treats an entry stored under another rollup version as a miss', () => {
    cache.set(key, history('a'), 1);
    expect(cache.get(key, 2)).toBeNull();
    expect(cache.get(key, 0)).toBeNull();
  });

  it('defaults both sides to version 0', () => {
    const value = history('a');
    cache.set(key, value);
    expect(cache.get(key)).toBe(value);
  });

  it('expires an entry after 15 minutes even under the same version', () => {
    cache.set(key, history('a'), 3);
    now = T0 + FARM_HISTORY_FRESH_MS - 1;
    expect(cache.get(key, 3)).not.toBeNull();
    now = T0 + FARM_HISTORY_FRESH_MS;
    expect(cache.get(key, 3)).toBeNull();
  });

  it('misses for other days of the same range', () => {
    cache.set(key, history('a'), 1);
    expect(cache.get({ ...key, to: '2026-01-05T00:00:00.000Z' }, 1)).toBeNull();
  });
});
