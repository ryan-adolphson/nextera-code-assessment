/**
 * Whole days chosen with a Material date range picker (native DateAdapter), in the zone times are
 * shown in (Settings: UTC by default, or the browser's zone): the alert history and reports query
 * [start 00:00, the day after end 00:00) in that zone. A day is its midnight in the zone (epoch
 * ms); calendar maths runs in the zone's date-fns context, so a DST day is 23 or 25 hours long.
 * Every helper takes the zone ("UTC" by default).
 */

import { TZDate } from '@date-fns/tz';
import { addDays, differenceInCalendarDays, format, startOfDay, subDays } from 'date-fns';
import { millisecondsInDay } from 'date-fns/constants';
import { UTC_ZONE, zoneContext } from './time-zone';

/** The longest range the API accepts (GET /api/alerts, GET /api/reports/telemetry): 31 whole days. */
export const MAX_RANGE_DAYS = 31;

/**
 * The day (its midnight in `zone`, epoch ms) a picked calendar date stands for. The datepicker's
 * native DateAdapter yields browser-local-midnight Dates; their year/month/day name the day.
 */
export function zoneDayOf(date: Date, zone: string = UTC_ZONE): number {
  const [y, m, d] = [date.getFullYear(), date.getMonth(), date.getDate()];
  return zone === UTC_ZONE ? Date.UTC(y, m, d) : +new TZDate(y, m, d, zone);
}

/** A picked Date as its day in `zone`, or null (not chosen, or an invalid typed date). */
export function dayOf(date: Date | null, zone: string = UTC_ZONE): number | null {
  return date && !Number.isNaN(date.getTime()) ? zoneDayOf(date, zone) : null;
}

/** The calendar date the datepicker shows for a day in `zone` (the inverse of `zoneDayOf`). */
export function pickerDate(day: number, zone: string = UTC_ZONE): Date {
  const d = zoneContext(zone)(day);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** The default days: yesterday and today (in `zone`), so the last 24 hours are always included. */
export function defaultDays(now: number, zone: string = UTC_ZONE): { start: number; end: number } {
  const ctx = zoneContext(zone);
  const today = startOfDay(now, { in: ctx });
  return { start: +subDays(today, 1, { in: ctx }), end: +today };
}

/** Whole days [start 00:00, the day after end 00:00) in `zone`, as the API's [from, to). */
export function dayRange(
  start: number,
  end: number,
  zone: string = UTC_ZONE,
): { from: string; to: string } {
  return {
    from: new Date(start).toISOString(),
    to: new Date(+addDays(end, 1, { in: zoneContext(zone) })).toISOString(),
  };
}

/**
 * The last whole day (its midnight in `zone`, epoch ms) of a [from, to) range that ends at a
 * midnight: the day before `to`. Epoch ms, not the zoned Date date-fns returns.
 */
export function lastDay(to: string, zone: string = UTC_ZONE): number {
  return +subDays(to, 1, { in: zoneContext(zone) });
}

/** "2026-01-02": a day in `zone`, as in file names. */
export function isoDay(date: Date | string | number, zone: string = UTC_ZONE): string {
  return format(date, 'yyyy-MM-dd', { in: zoneContext(zone) });
}

/**
 * Why a day range cannot be queried, or null when it can (mirrors the API's 400s). Both days are
 * midnights in `zone` (`zoneDayOf`), or null while not chosen or not a valid date. The API allows
 * at most 31 × 24 hours, so in a zone with DST, 31 days that gain an hour (autumn) are too long.
 */
export function rangeError(
  start: number | null,
  end: number | null,
  zone: string = UTC_ZONE,
): string | null {
  if (start === null) return 'Choose a start date.';
  if (end === null) return 'Choose an end date.';
  if (end < start) return 'The end date must not be before the start date.';
  if (differenceInCalendarDays(end, start, { in: zoneContext(zone) }) + 1 > MAX_RANGE_DAYS)
    return `Choose at most ${MAX_RANGE_DAYS} days.`;
  const { from, to } = dayRange(start, end, zone);
  if (Date.parse(to) - Date.parse(from) > MAX_RANGE_DAYS * millisecondsInDay)
    return `Choose at most ${MAX_RANGE_DAYS - 1} days when the range includes a daylight-saving change.`;
  return null;
}
