import {
  formatTimestamp,
  isIsolated,
  nearestIndex,
  paddedRange,
  ticksWithin,
  timeTicks,
  withGapBreaks,
  candleSizeFor,
  formatDuration,
  toCandles,
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

describe('12-hour clock', () => {
  it('labels ticks compactly: "2 PM" on the hour, "2:30 PM" otherwise, the date at midnight', () => {
    const ticks = timeTicks(
      t0 + 22 * 60 * MIN,
      t0 + 26 * 60 * MIN + 30 * MIN,
      640,
      80,
      'UTC',
      true,
    );
    expect(ticks.map((t) => t.label)).toEqual(['10 PM', '11 PM', 'Jan 2', '1 AM', '2 AM']);
    const half = timeTicks(t0 + 12 * 60 * MIN, t0 + 14 * 60 * MIN, 640, 80, 'UTC', true);
    expect(half.map((t) => t.label)).toContain('12:30 PM');
    expect(half.map((t) => t.label)).toContain('12 PM');
  });

  it('keeps wider labels apart: fewer ticks than the 24-hour clock in a tight width', () => {
    const range = [t0, t0 + 12 * 60 * MIN] as const;
    expect(timeTicks(...range, 400, 80, 'UTC', true).length).toBeLessThanOrEqual(
      timeTicks(...range, 400, 80, 'UTC', false).length,
    );
    const labels = timeTicks(...range, 400, 80, 'UTC', true);
    expect(labels.length * 100).toBeLessThanOrEqual(400 + 100);
  });

  it('formats a timestamp with the zone name', () => {
    expect(formatTimestamp(Date.parse('2026-01-02T15:05:00Z'), 'UTC', true)).toBe(
      'Jan 2, 3:05 PM UTC',
    );
    expect(formatTimestamp(Date.parse('2026-01-02T15:05:00Z'))).toBe('Jan 2, 15:05 UTC');
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

describe('candles', () => {
  const H = 3_600_000;
  const M = 60_000;
  const t0 = Date.parse('2026-01-02T03:00:00Z');

  it('sizes candles to the range: about 24–48 per chart', () => {
    expect(candleSizeFor(6 * H)).toBe(15 * M);
    expect(candleSizeFor(24 * H)).toBe(30 * M);
    expect(candleSizeFor(48 * H)).toBe(H);
    expect(candleSizeFor(7 * 24 * H)).toBe(4 * H);
    expect([15 * M, 30 * M, H, 4 * H].map(formatDuration)).toEqual([
      '15 min',
      '30 min',
      '1 h',
      '4 h',
    ]);
  });

  it('takes open/close from the first/last reading and low/high from the bucket, UTC-aligned', () => {
    const points = [
      { t: t0, v: 82.1 },
      { t: t0 + 5 * M, v: 81.9 },
      { t: t0 + 20 * M, v: 126.5 },
      { t: t0 + 25 * M, v: 90 },
      { t: t0 + 35 * M, v: 81.9 },
    ];
    expect(toCandles(points, 30 * M)).toEqual([
      {
        t: t0 + 15 * M,
        start: t0,
        end: t0 + 30 * M,
        open: 82.1,
        close: 90,
        low: 81.9,
        high: 126.5,
        count: 4,
      },
      {
        t: t0 + 45 * M,
        start: t0 + 30 * M,
        end: t0 + 60 * M,
        open: 81.9,
        close: 81.9,
        low: 81.9,
        high: 81.9,
        count: 1,
      },
    ]);
  });

  it('leaves empty buckets out, so gaps stay visible', () => {
    const candles = toCandles(
      [
        { t: t0, v: 1 },
        { t: t0 + 2 * H, v: 2 },
      ],
      30 * M,
    );
    expect(candles.map((c) => c.start)).toEqual([t0, t0 + 2 * H]);
    expect(toCandles([], 30 * M)).toEqual([]);
  });
});

/** Local time: US DST changes in America/Chicago (2026-03-08 and 2026-11-01), and +5:30 Kolkata. */
describe('in a local time zone', () => {
  const CHICAGO = 'America/Chicago';
  const KOLKATA = 'Asia/Kolkata';
  const H = 60 * MIN;
  const at = (iso: string) => Date.parse(iso);
  const iso = (t: number) => new Date(t).toISOString().slice(0, 16);
  const ticks = (from: string, to: string, zone: string, width = 640) =>
    timeTicks(at(from), at(to), width, 80, zone).map((tick) => [iso(tick.t), tick.label]);

  it('follows the clock on a spring-forward day (02:00 does not exist)', () => {
    expect(ticks('2026-03-08T06:00Z', '2026-03-08T12:00Z', CHICAGO)).toEqual([
      ['2026-03-08T06:00', 'Mar 8'], // 00:00 CST
      ['2026-03-08T07:00', '01:00'],
      ['2026-03-08T08:00', '03:00'], // 03:00 CDT
      ['2026-03-08T09:00', '04:00'],
      ['2026-03-08T10:00', '05:00'],
      ['2026-03-08T11:00', '06:00'],
      ['2026-03-08T12:00', '07:00'],
    ]);
  });

  it('shows the repeated hour on a fall-back day', () => {
    expect(ticks('2026-11-01T05:00Z', '2026-11-01T11:00Z', CHICAGO)).toEqual([
      ['2026-11-01T05:00', 'Nov 1'], // 00:00 CDT
      ['2026-11-01T06:00', '01:00'], // 01:00 CDT
      ['2026-11-01T07:00', '01:00'], // 01:00 CST
      ['2026-11-01T08:00', '02:00'],
      ['2026-11-01T09:00', '03:00'],
      ['2026-11-01T10:00', '04:00'],
      ['2026-11-01T11:00', '05:00'],
    ]);
  });

  it('puts day ticks on local midnights across a DST change (23-hour day)', () => {
    expect(ticks('2026-03-05T06:00Z', '2026-03-12T05:00Z', CHICAGO)).toEqual([
      ['2026-03-05T06:00', 'Mar 5'],
      ['2026-03-06T06:00', 'Mar 6'],
      ['2026-03-07T06:00', 'Mar 7'],
      ['2026-03-08T06:00', 'Mar 8'],
      ['2026-03-09T05:00', 'Mar 9'], // CDT from here
      ['2026-03-10T05:00', 'Mar 10'],
      ['2026-03-11T05:00', 'Mar 11'],
      ['2026-03-12T05:00', 'Mar 12'],
    ]);
    // Day steps on a narrow chart: still local midnights.
    const wide = timeTicks(at('2026-10-28T05:00Z'), at('2026-11-07T06:00Z'), 320, 80, CHICAGO);
    expect(wide.every((tick) => /^[A-Z][a-z]{2} \d+$/.test(tick.label))).toBe(true);
    expect(wide.map((tick) => iso(tick.t))).toContain('2026-11-03T06:00');
  });

  it('steps whole days over months of daily candles, on local midnights', () => {
    // 30 days at 640 px: every 4th day; 182 days: every 28th. All local midnights, DST or not.
    const month = timeTicks(at('2026-10-03T05:00Z'), at('2026-11-02T06:00Z'), 640, 80, CHICAGO);
    expect(month.length).toBeGreaterThanOrEqual(6);
    expect(month.length).toBeLessThanOrEqual(8);
    expect(month.every((tick) => /^[A-Z][a-z]{2} \d+$/.test(tick.label))).toBe(true);
    expect(month.slice(1).every((tick, i) => tick.t - month[i].t === 96 * H)).toBe(true);
    const half = timeTicks(at('2026-05-04T05:00Z'), at('2026-11-02T06:00Z'), 640, 80, CHICAGO);
    expect(half.length).toBeLessThanOrEqual(8);
    expect(half.slice(1).every((tick, i) => Math.round((tick.t - half[i].t) / H / 24) === 28)).toBe(
      true,
    );
    expect(half.every((tick) => /^[A-Z][a-z]{2} \d+$/.test(tick.label))).toBe(true);
  });

  it('aligns ticks to whole local hours in a +5:30 zone, with the date at its midnight', () => {
    expect(ticks('2026-01-01T00:00Z', '2026-01-01T06:00Z', KOLKATA).map(([, l]) => l)).toEqual([
      '06:00',
      '07:00',
      '08:00',
      '09:00',
      '10:00',
      '11:00',
    ]);
    expect(ticks('2026-01-01T16:00Z', '2026-01-01T22:00Z', KOLKATA)).toContainEqual([
      '2026-01-01T18:30',
      'Jan 2',
    ]);
  });

  it('formats timestamps with the zone name for the instant', () => {
    expect(formatTimestamp(at('2026-01-02T03:25:00Z'), CHICAGO)).toBe('Jan 1, 21:25 CST');
    expect(formatTimestamp(at('2026-07-02T03:25:00Z'), CHICAGO)).toBe('Jul 1, 22:25 CDT');
    expect(formatTimestamp(at('2026-01-02T03:25:00Z'), KOLKATA)).toBe('Jan 2, 08:55 GMT+5:30');
  });

  const hourly = (from: string, count: number, stepMs = H) =>
    Array.from({ length: count }, (_, i) => ({ t: at(from) + i * stepMs, v: i }));
  const spans = (candles: ReturnType<typeof toCandles>) =>
    candles.map((c) => [iso(c.start), iso(c.end), c.count]);

  it('makes 4-hour candles of local hours: 3 h long on spring forward, 5 h on fall back', () => {
    expect(spans(toCandles(hourly('2026-03-08T06:00Z', 8), 4 * H, CHICAGO))).toEqual([
      ['2026-03-08T06:00', '2026-03-08T09:00', 3], // 00:00 CST – 04:00 CDT
      ['2026-03-08T09:00', '2026-03-08T13:00', 4],
      ['2026-03-08T13:00', '2026-03-08T17:00', 1],
    ]);
    expect(spans(toCandles(hourly('2026-11-01T05:00Z', 6), 4 * H, CHICAGO))).toEqual([
      ['2026-11-01T05:00', '2026-11-01T10:00', 5], // 00:00 CDT – 04:00 CST
      ['2026-11-01T10:00', '2026-11-01T14:00', 1],
    ]);
    const [first] = toCandles(hourly('2026-11-01T05:00Z', 1), 4 * H, CHICAGO);
    expect(first.t).toBe((first.start + first.end) / 2);
  });

  it('gives the repeated fall-back hour its own hourly candle', () => {
    expect(spans(toCandles(hourly('2026-11-01T06:00Z', 5, 30 * MIN), H, CHICAGO))).toEqual([
      ['2026-11-01T06:00', '2026-11-01T07:00', 2], // 01:00 CDT
      ['2026-11-01T07:00', '2026-11-01T08:00', 2], // 01:00 CST
      ['2026-11-01T08:00', '2026-11-01T09:00', 1],
    ]);
  });

  it('aligns candles to the half hour in a +5:30 zone', () => {
    const point = [{ t: at('2026-01-01T00:10:00Z'), v: 1 }];
    expect(spans(toCandles(point, 30 * MIN, KOLKATA))).toEqual([
      ['2026-01-01T00:00', '2026-01-01T00:30', 1], // 05:30–06:00 IST
    ]);
    expect(spans(toCandles(point, H, KOLKATA))).toEqual([
      ['2025-12-31T23:30', '2026-01-01T00:30', 1], // 05:00–06:00 IST
    ]);
    expect(spans(toCandles(point, 4 * H, KOLKATA))).toEqual([
      ['2025-12-31T22:30', '2026-01-01T02:30', 1], // 04:00–08:00 IST
    ]);
  });

  it('keeps UTC 4-hour candles on UTC hours', () => {
    expect(spans(toCandles(hourly('2026-01-01T01:00Z', 4), 4 * H))).toEqual([
      ['2026-01-01T00:00', '2026-01-01T04:00', 3],
      ['2026-01-01T04:00', '2026-01-01T08:00', 1],
    ]);
  });
});
