import { DatePipe } from '@angular/common';
import {
  dayOf,
  dayRange,
  defaultDays,
  isoDay,
  lastDay,
  pickerDate,
  rangeError,
  zoneDayOf,
} from './days';

describe('UTC days from the datepicker', () => {
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

  it('reads a picked calendar date (a local midnight) as that UTC day, and back', () => {
    expect(zoneDayOf(new Date(2026, 0, 2))).toBe(day('2026-01-02'));
    const shown = pickerDate(day('2026-01-02'));
    expect([shown.getFullYear(), shown.getMonth(), shown.getDate()]).toEqual([2026, 0, 2]);
    expect(zoneDayOf(pickerDate(day('2026-12-31')))).toBe(day('2026-12-31'));
  });

  it('defaults to yesterday and today (UTC), so the last 24 hours are included', () => {
    expect(defaultDays(Date.parse('2026-01-03T00:00:30Z'))).toEqual({
      start: day('2026-01-02'),
      end: day('2026-01-03'),
    });
  });

  it('queries whole days: start 00:00 to the day after the end, 00:00 (exclusive)', () => {
    expect(dayRange(day('2026-01-02'), day('2026-01-03'))).toEqual({
      from: '2026-01-02T00:00:00.000Z',
      to: '2026-01-04T00:00:00.000Z',
    });
    // One day: that day's 24 hours.
    expect(dayRange(day('2026-01-02'), day('2026-01-02'))).toEqual({
      from: '2026-01-02T00:00:00.000Z',
      to: '2026-01-03T00:00:00.000Z',
    });
  });
});

describe('rangeError', () => {
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
  it('accepts one day up to 31 days', () => {
    expect(rangeError(day('2026-01-02'), day('2026-01-02'))).toBeNull();
    expect(rangeError(day('2026-01-01'), day('2026-01-31'))).toBeNull(); // 31 days
  });
  it.each([
    [null, day('2026-01-02'), 'Choose a start date.'],
    [day('2026-01-02'), null, 'Choose an end date.'],
    [day('2026-01-03'), day('2026-01-02'), 'The end date must not be before the start date.'],
    [day('2026-01-01'), day('2026-02-01'), 'Choose at most 31 days.'], // 32 days
  ])('explains %s → %s', (start, end, message) => {
    expect(rangeError(start, end)).toBe(message);
  });
});

describe('lastDay and isoDay', () => {
  it('gives the last whole day of a [from, to) range as epoch ms, and names days for files', () => {
    expect(lastDay('2026-01-03T00:00:00.000Z')).toBe(Date.parse('2026-01-02T00:00:00Z'));
    expect(isoDay(lastDay('2026-01-03T00:00:00.000Z'))).toBe('2026-01-02');
    expect(isoDay('2026-01-01T00:00:00.000Z')).toBe('2026-01-01');
  });

  it('formats right with DatePipe in UTC (a UTCDate would be shifted a second time)', () => {
    const day = lastDay('2026-01-03T00:00:00.000Z');
    expect(new DatePipe('en-US').transform(day, 'MMM d, y', 'UTC')).toBe('Jan 2, 2026');
  });
});

describe('dayOf', () => {
  it('reads a picked Date as its UTC day, and gives null for none or an invalid typed date', () => {
    expect(dayOf(new Date(2026, 0, 2))).toBe(Date.parse('2026-01-02T00:00:00Z'));
    expect(dayOf(null)).toBeNull();
    expect(dayOf(new Date('not a date'))).toBeNull();
  });
});

/** Local days: a DST-observing zone and a +5:30 one (no DST). */
describe('days in a time zone', () => {
  const CHICAGO = 'America/Chicago';
  const KOLKATA = 'Asia/Kolkata';

  it('reads a picked calendar date as midnight in the zone, and back', () => {
    // CST (UTC−6) in winter, CDT (UTC−5) in summer; IST (UTC+5:30) all year.
    expect(zoneDayOf(new Date(2026, 0, 2), CHICAGO)).toBe(Date.parse('2026-01-02T06:00:00Z'));
    expect(zoneDayOf(new Date(2026, 6, 2), CHICAGO)).toBe(Date.parse('2026-07-02T05:00:00Z'));
    expect(zoneDayOf(new Date(2026, 0, 2), KOLKATA)).toBe(Date.parse('2026-01-01T18:30:00Z'));
    const shown = pickerDate(Date.parse('2026-01-01T18:30:00Z'), KOLKATA);
    expect([shown.getFullYear(), shown.getMonth(), shown.getDate()]).toEqual([2026, 0, 2]);
    expect(dayOf(new Date(2026, 2, 8), CHICAGO)).toBe(Date.parse('2026-03-08T06:00:00Z'));
  });

  it('defaults to yesterday and today in the zone', () => {
    // 2026-01-03 03:00 UTC is still Jan 2 in Chicago (21:00 CST).
    expect(defaultDays(Date.parse('2026-01-03T03:00:00Z'), CHICAGO)).toEqual({
      start: Date.parse('2026-01-01T06:00:00Z'),
      end: Date.parse('2026-01-02T06:00:00Z'),
    });
    expect(defaultDays(Date.parse('2026-01-03T03:00:00Z'), KOLKATA)).toEqual({
      start: Date.parse('2026-01-01T18:30:00Z'),
      end: Date.parse('2026-01-02T18:30:00Z'),
    });
  });

  it('queries whole local days: a spring-forward day is 23 hours, a fall-back day 25', () => {
    const march8 = zoneDayOf(new Date(2026, 2, 8), CHICAGO);
    expect(dayRange(march8, march8, CHICAGO)).toEqual({
      from: '2026-03-08T06:00:00.000Z', // 00:00 CST
      to: '2026-03-09T05:00:00.000Z', // 00:00 CDT, 23 h later
    });
    const nov1 = zoneDayOf(new Date(2026, 10, 1), CHICAGO);
    expect(dayRange(nov1, nov1, CHICAGO)).toEqual({
      from: '2026-11-01T05:00:00.000Z', // 00:00 CDT
      to: '2026-11-02T06:00:00.000Z', // 00:00 CST, 25 h later
    });
    expect(
      dayRange(
        zoneDayOf(new Date(2026, 0, 2), KOLKATA),
        zoneDayOf(new Date(2026, 0, 3), KOLKATA),
        KOLKATA,
      ),
    ).toEqual({
      from: '2026-01-01T18:30:00.000Z',
      to: '2026-01-03T18:30:00.000Z',
    });
  });

  it('gives the last day and file-name days in the zone', () => {
    expect(lastDay('2026-11-02T06:00:00.000Z', CHICAGO)).toBe(Date.parse('2026-11-01T05:00:00Z'));
    expect(isoDay('2026-11-01T05:00:00.000Z', CHICAGO)).toBe('2026-11-01');
    expect(isoDay('2026-11-01T05:00:00.000Z')).toBe('2026-11-01'); // UTC by default
    expect(isoDay('2026-01-01T18:30:00.000Z', KOLKATA)).toBe('2026-01-02');
  });

  it('allows 31 local days, but only 30 when they gain an hour (the API allows 31 × 24 h)', () => {
    const day = (m: number, d: number) => zoneDayOf(new Date(2026, m, d), CHICAGO);
    expect(rangeError(day(0, 1), day(0, 31), CHICAGO)).toBeNull();
    expect(rangeError(day(0, 1), day(1, 1), CHICAGO)).toBe('Choose at most 31 days.');
    // Spring forward: 31 days are 31 × 24 h − 1 h.
    expect(rangeError(day(2, 1), day(2, 31), CHICAGO)).toBeNull();
    // Fall back: 31 days (Oct 15 – Nov 14) are 31 × 24 h + 1 h, which the API refuses.
    expect(rangeError(day(9, 15), day(10, 14), CHICAGO)).toBe(
      'Choose at most 30 days when the range includes a daylight-saving change.',
    );
    expect(rangeError(day(9, 16), day(10, 14), CHICAGO)).toBeNull();
  });
});
