import { compareEventIds } from './event-store.js';

// Publishing, fan-out and Last-Event-ID replay run against a real Redis in apps/api/test/events.e2e-spec.ts.
describe('compareEventIds', () => {
  it.each([
    ['1-0', '2-0', -1],
    ['2-0', '1-0', 1],
    ['5-1', '5-2', -1],
    ['5-2', '5-2', 0],
    ['10-0', '9-99', 1], // numeric, not lexicographic
    ['1791062218154-0', '1791062218154-10', -1],
  ])('compare(%s, %s) = %i', (a, b, expected) => {
    expect(compareEventIds(a, b)).toBe(expected);
  });
});
