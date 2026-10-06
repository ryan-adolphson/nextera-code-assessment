import { STALENESS_LABELS, STALENESS_LEVELS, freshestStaleness, stalenessOf } from './staleness';
import { reading } from './testing';

describe('stalenessOf', () => {
  const MINUTE = 60_000;
  const MEASURED = Date.parse('2026-01-02T23:55:00.000Z');
  const latest = reading({ timestamp: new Date(MEASURED).toISOString() });
  const at = (ageMs: number) => stalenessOf(latest, MEASURED + ageMs);

  it('is reporting up to and including 15 minutes (strictly greater flags)', () => {
    expect(at(0)).toBe('ok');
    expect(at(5 * MINUTE)).toBe('ok');
    expect(at(15 * MINUTE)).toBe('ok');
    expect(at(15 * MINUTE + 1)).toBe('stale-15');
  });

  it('moves to the 30 and 60 minute levels just after each threshold', () => {
    expect(at(30 * MINUTE)).toBe('stale-15');
    expect(at(30 * MINUTE + 1)).toBe('stale-30');
    expect(at(60 * MINUTE)).toBe('stale-30');
    expect(at(60 * MINUTE + 1)).toBe('stale-60');
    expect(at(280 * 24 * 60 * MINUTE)).toBe('stale-60'); // historical seed data
  });

  it('treats a reading dated ahead of the clock (clock skew) as reporting', () => {
    expect(at(-10 * MINUTE)).toBe('ok');
  });

  it('is empty when the turbine has never reported', () => {
    expect(stalenessOf(null, MEASURED)).toBe('empty');
    expect(stalenessOf(undefined, MEASURED)).toBe('empty');
  });

  it("labels the levels with the user's wording", () => {
    expect(STALENESS_LEVELS.map((l) => [l.level, l.afterMs / MINUTE])).toEqual([
      ['stale-15', 15],
      ['stale-30', 30],
      ['stale-60', 60],
    ]);
    expect(STALENESS_LABELS).toEqual({
      ok: 'Reporting',
      'stale-15': 'No data in 15 min',
      'stale-30': 'No data in 30 min',
      'stale-60': 'No data in 60 min',
      empty: 'No readings yet',
    });
  });
});

describe('freshestStaleness', () => {
  it('picks the freshest level, ignoring turbines that never reported', () => {
    expect(freshestStaleness(['stale-60', 'ok', 'stale-15'])).toBe('ok');
    expect(freshestStaleness(['stale-60', 'stale-30', 'empty'])).toBe('stale-30');
    expect(freshestStaleness(['empty', 'stale-60'])).toBe('stale-60');
  });

  it('is empty when nothing ever reported, or there is nothing', () => {
    expect(freshestStaleness(['empty', 'empty'])).toBe('empty');
    expect(freshestStaleness([])).toBe('empty');
  });
});
