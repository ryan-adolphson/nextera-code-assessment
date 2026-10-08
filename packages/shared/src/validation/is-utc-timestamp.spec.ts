import {
  MAX_FUTURE_SKEW_MS,
  MIN_TIMESTAMP_MS,
  timestampProblem,
} from './is-utc-timestamp.js';

// The decorator's behaviour is covered through the DTOs that use it (ingestion payloads, API
// queries); this pins the options.
describe('timestampProblem', () => {
  const NOW = new Date('2026-10-08T12:00:00Z');
  const late = new Date(NOW.getTime() + MAX_FUTURE_SKEW_MS + 1).toISOString();

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it('bounds the future by default', () => {
    expect(timestampProblem(late)).toBe('future');
    expect(timestampProblem('2026-10-08T12:05:00Z')).toBeUndefined();
  });

  it('accepts any future instant with allowFuture', () => {
    expect(timestampProblem(late, { allowFuture: true })).toBeUndefined();
    expect(
      timestampProblem('2099-01-01T00:00:00Z', { allowFuture: true }),
    ).toBeUndefined();
  });

  it('still checks the format and the calendar with allowFuture', () => {
    expect(timestampProblem('2026-W02-3', { allowFuture: true })).toBe(
      'format',
    );
    expect(timestampProblem('2026-01-01T00:00:00', { allowFuture: true })).toBe(
      'format',
    );
    expect(
      timestampProblem('2026-02-30T00:00:00Z', { allowFuture: true }),
    ).toBe('calendar');
  });

  it('applies minMs only when given', () => {
    expect(timestampProblem('1999-12-31T23:59:59Z')).toBeUndefined();
    expect(
      timestampProblem('1999-12-31T23:59:59Z', { minMs: MIN_TIMESTAMP_MS }),
    ).toBe('past');
  });
});
