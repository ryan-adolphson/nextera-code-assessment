import {
  formatTimestamp,
  isIsolated,
  nearestIndex,
  paddedRange,
  ticksWithin,
  timeTicks,
  withGapBreaks,
} from './scales';

const MIN = 60_000;
const t0 = Date.parse('2026-01-01T00:00:00Z');

describe('timeTicks', () => {
  it('chooses a step that keeps labels apart and aligns to UTC hours', () => {
    const ticks = timeTicks(t0 + 7 * MIN, t0 + 6 * 60 * MIN, 640);
    expect(ticks.map((t) => t.label)).toEqual([
      '01:00',
      '02:00',
      '03:00',
      '04:00',
      '05:00',
      '06:00',
    ]);
  });

  it('labels midnight with the date over multi-day ranges', () => {
    const ticks = timeTicks(t0 - 12 * 60 * MIN, t0 + 36 * 60 * MIN, 640);
    expect(ticks.map((t) => t.label)).toContain('Jan 1');
    expect(ticks.map((t) => t.label)).toContain('Jan 2');
  });

  it('uses fewer ticks on narrow charts', () => {
    const range: [number, number] = [t0, t0 + 24 * 60 * MIN];
    expect(timeTicks(...range, 320).length).toBeLessThan(timeTicks(...range, 960).length);
  });
});

describe('nearestIndex', () => {
  const points = [0, 5, 10].map((m) => ({ t: t0 + m * MIN, v: m }));

  it.each([
    [-3, 0],
    [2, 0],
    [3, 1],
    [7, 1],
    [8, 2],
    [99, 2],
  ])('snaps minute %i to point %i', (minute, index) => {
    expect(nearestIndex(points, t0 + minute * MIN)).toBe(index);
  });

  it('returns -1 without points', () => {
    expect(nearestIndex([], t0)).toBe(-1);
  });
});

it('formats timestamps in UTC', () => {
  expect(formatTimestamp(Date.parse('2026-01-02T03:25:00Z'))).toBe('Jan 2, 03:25 UTC');
});

describe('withGapBreaks / isIsolated (line data)', () => {
  const at = (minute: number) => ({ t: t0 + minute * MIN, v: minute });

  it('inserts a null between readings further apart than the gap, so the line breaks', () => {
    const data = withGapBreaks([at(0), at(5), at(15), at(40)], 7.5 * MIN);
    expect(data.map((d) => d.y)).toEqual([0, 5, null, 15, null, 40]);
  });

  it('flags readings with no connected neighbour', () => {
    const data = withGapBreaks([at(0), at(5), at(20), at(40), at(45)], 7.5 * MIN);
    expect(data.map((_, i) => isIsolated(data, i))).toEqual([
      false,
      false,
      false,
      true,
      false,
      false,
      false,
    ]);
  });
});

describe('paddedRange (zoom limits)', () => {
  it('adds 10% of the range on each side', () => {
    const r = paddedRange(5.9, 15.8);
    expect(r.min).toBeCloseTo(4.91);
    expect(r.max).toBeCloseTo(16.79);
  });

  it('does not pad below zero for non-negative data (power output)', () => {
    expect(paddedRange(0, 3500)).toEqual({ min: 0, max: 3850 });
    expect(paddedRange(100, 3500).min).toBe(0); // 100 - 340 would be negative
  });

  it('pads below zero when the data is already negative', () => {
    expect(paddedRange(-5, 15)).toEqual({ min: -7, max: 17 });
  });

  it('gives a flat series (frozen sensor) a visible range', () => {
    const r = paddedRange(126.5, 126.5);
    expect(r.min).toBeCloseTo(113.85);
    expect(r.max).toBeCloseTo(139.15);
  });
});

describe('ticksWithin (y ticks inside padded or zoomed bounds)', () => {
  it('picks a round step for about four intervals, never outside the bounds', () => {
    expect(ticksWithin(77.44, 130.96)).toEqual([80, 90, 100, 110, 120, 130]);
    expect(ticksWithin(4.91, 16.79)).toEqual([6, 8, 10, 12, 14, 16]);
    expect(ticksWithin(0, 3850)).toEqual([0, 1000, 2000, 3000]);
  });

  it('includes a bound that is itself a tick', () => {
    expect(ticksWithin(90, 100)).toEqual([90, 92, 94, 96, 98, 100]);
  });

  it('handles negative and fractional ranges without float noise', () => {
    expect(ticksWithin(-7, 17)).toEqual([-5, 0, 5, 10, 15]);
    expect(ticksWithin(0.11, 0.49)).toEqual([0.2, 0.3, 0.4]);
  });

  it('returns no ticks for an empty range', () => {
    expect(ticksWithin(5, 5)).toEqual([]);
  });
});
