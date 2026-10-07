/**
 * Whole UTC days chosen with a Material date range picker (native DateAdapter): the alert history
 * and reports query [start 00:00, the day after end 00:00) in UTC, like every time in the app.
 */

import { utc } from '@date-fns/utc';
import { addDays, differenceInCalendarDays, format, startOfDay, subDays } from 'date-fns';

/** The longest range the API accepts (GET /api/alerts, GET /api/reports/telemetry): 31 whole days. */
export const MAX_RANGE_DAYS = 31;

/**
 * The UTC day (its midnight, epoch ms) a picked calendar date stands for. The datepicker's native
 * DateAdapter yields local-midnight Dates; their year/month/day are read as a UTC day, because the
 * app shows UTC everywhere.
 */
export function utcDayOf(date: Date): number {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate());
}

/** The calendar date the datepicker shows for a UTC day (the inverse of `utcDayOf`). */
export function pickerDate(utcDay: number): Date {
  const d = new Date(utcDay);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** The default days: yesterday and today (UTC), so the last 24 hours are always included. */
export function defaultDays(now: number): { start: number; end: number } {
  const today = startOfDay(now, { in: utc });
  return { start: +subDays(today, 1), end: +today };
}

/** Whole UTC days [start 00:00, the day after end 00:00) as the API's [from, to). */
export function dayRange(start: number, end: number): { from: string; to: string } {
  return {
    from: new Date(start).toISOString(),
    to: addDays(end, 1, { in: utc }).toISOString(),
  };
}

/**
 * The last whole UTC day (its midnight, epoch ms) of a [from, to) range that ends at a midnight:
 * the day before `to`. Epoch ms, not the `UTCDate` date-fns returns with `{ in: utc }`: Angular's
 * DatePipe would apply the UTC offset to it a second time.
 */
export function lastUtcDay(to: string): number {
  return +subDays(to, 1, { in: utc });
}

/** "2026-01-02": a UTC day as in file names. */
export function isoDay(date: Date | string | number): string {
  return format(date, 'yyyy-MM-dd', { in: utc });
}

/**
 * Why a day range cannot be queried, or null when it can (mirrors the API's 400s). Both days are
 * UTC midnights (`utcDayOf`), or null while not chosen or not a valid date.
 */
export function rangeError(start: number | null, end: number | null): string | null {
  if (start === null) return 'Choose a start date.';
  if (end === null) return 'Choose an end date.';
  if (end < start) return 'The end date must not be before the start date.';
  if (differenceInCalendarDays(end, start, { in: utc }) + 1 > MAX_RANGE_DAYS)
    return `Choose at most ${MAX_RANGE_DAYS} days.`;
  return null;
}
