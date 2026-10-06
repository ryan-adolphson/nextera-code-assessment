import { alertCounts, alertsOf, formatAge } from './alerts';
import { Staleness } from './staleness';

const t = (id: string, staleness: Staleness, timestamp?: string) => ({
  id,
  staleness,
  latest: timestamp ? { timestamp } : null,
});

describe('alertsOf', () => {
  it('keeps only turbines needing attention, worst level first, longest silent first', () => {
    const turbines = [
      t('A', 'ok', '2026-01-02T23:55:00Z'),
      t('B', 'empty'),
      t('C', 'stale-15', '2026-01-02T23:40:00Z'),
      t('D', 'stale-60', '2026-01-02T22:00:00Z'),
      t('E', 'stale-30', '2026-01-02T23:20:00Z'),
      t('F', 'stale-60', '2026-01-02T21:30:00Z'),
      t('G', 'stale-60', '2026-01-02T22:00:00Z'),
      t('AA', 'empty'),
    ];
    expect(alertsOf(turbines).map((x) => x.id)).toEqual(['F', 'D', 'G', 'E', 'C', 'AA', 'B']);
  });

  it('does not reorder its input', () => {
    const turbines = [t('B', 'empty'), t('A', 'empty')];
    alertsOf(turbines);
    expect(turbines.map((x) => x.id)).toEqual(['B', 'A']);
  });
});

describe('alertCounts', () => {
  it('counts every alert level, zero included', () => {
    expect(
      alertCounts([t('A', 'ok'), t('B', 'empty'), t('C', 'stale-60'), t('D', 'stale-60')]),
    ).toEqual({ 'stale-60': 2, 'stale-30': 0, 'stale-15': 0, empty: 1 });
  });
});

describe('formatAge', () => {
  const MIN = 60_000;
  it.each([
    [-5 * MIN, '0 min'],
    [59_999, '0 min'],
    [16 * MIN, '16 min'],
    [60 * MIN, '1 h'],
    [125 * MIN, '2 h 5 min'],
    [47 * 60 * MIN + 59 * MIN, '47 h 59 min'],
    [48 * 60 * MIN, '2 d'],
    [76 * 60 * MIN + 30 * MIN, '3 d 4 h'],
  ])('%i ms is "%s"', (ms, text) => expect(formatAge(ms)).toBe(text));
});
