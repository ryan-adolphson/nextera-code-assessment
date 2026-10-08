import { freshness } from './staleness.js';

const LATEST = '2026-10-08T12:00:00.000Z';
const at = (minutes: number, extraMs = 0) =>
  Date.parse(LATEST) + minutes * 60_000 + extraMs;

describe('freshness', () => {
  it.each([
    [0, 0, 'ok', 0],
    [15, 0, 'ok', 15], // exactly 15:00 old is still reporting
    [15, 1, 'stale-15', 15],
    [30, 0, 'stale-15', 30],
    [30, 1, 'stale-30', 30],
    [60, 0, 'stale-30', 60],
    [60, 1, 'stale-60', 60],
    [40 * 60, 0, 'stale-60', 2400],
  ])(
    '%i min + %i ms old → %s',
    (minutes, extraMs, status, minutesSinceLatest) => {
      expect(freshness(LATEST, at(minutes, extraMs))).toMatchObject({
        status,
        minutesSinceLatest,
      });
    },
  );

  it('labels the levels like the web app', () => {
    expect(freshness(LATEST, at(0)).statusLabel).toBe('Reporting');
    expect(freshness(LATEST, at(16)).statusLabel).toBe('No data in 15 min');
    expect(freshness(LATEST, at(61)).statusLabel).toBe('No data in 60 min');
  });

  it('counts a reading ahead of the clock (skew) as reporting', () => {
    expect(freshness(LATEST, at(-3))).toEqual({
      status: 'ok',
      statusLabel: 'Reporting',
      minutesSinceLatest: 0,
    });
  });

  it('is no-data for a turbine that never reported', () => {
    expect(freshness(null, at(0))).toEqual({
      status: 'no-data',
      statusLabel: 'No readings yet',
      minutesSinceLatest: null,
    });
  });
});
