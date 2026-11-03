import { addDays, startOfDay, subDays } from 'date-fns';
import { Candle } from '../charts/scales';
import { DayRange, dayRange, zoneDayOf } from '../core/days';
import { formatIn, zoneContext } from '../core/time-zone';
import { FarmDailyDay } from './farm-history.model';

/** The History tab's ranges: whole days ending today. "6 months" is 182 days (the API allows 183). */
export const FARM_HISTORY_RANGES = [
  { id: '30d', label: '30d', days: 30 },
  { id: '90d', label: '90d', days: 90 },
  { id: '6m', label: '6 months', days: 182 },
] as const;

export type FarmHistoryRange = (typeof FARM_HISTORY_RANGES)[number]['id'];

/** The last `days` whole days in `zone`, today included, as the API's [from, to). */
export function lastDays(now: number, days: number, zone: string): DayRange {
  const ctx = zoneContext(zone);
  const today = startOfDay(now, { in: ctx });
  return dayRange(+subDays(today, days - 1, { in: ctx }), +today, zone);
}

/** A YYYY-MM-DD day in `zone` as [start, end) (epoch ms): 23 or 25 hours on a DST day. */
export function daySpan(date: string, zone: string): { start: number; end: number } {
  const [y, m, d] = date.split('-').map(Number);
  const start = zoneDayOf(new Date(y, m - 1, d), zone);
  return { start, end: +addDays(start, 1, { in: zoneContext(zone) }) };
}

/**
 * The farm's power output as one candle per day, spanning that day in `zone` (drawn at its
 * centre), named by its date and "N of M turbines reporting" (M: the farm's turbines now).
 */
export function powerCandles(
  days: readonly FarmDailyDay[],
  turbineCount: number,
  zone: string,
): Candle[] {
  return days.map((day) => {
    const { start, end } = daySpan(day.date, zone);
    const { open, close, high, low } = day.powerOutputKw;
    return {
      t: (start + end) / 2,
      start,
      end,
      open,
      close,
      high,
      low,
      count: day.readings,
      label: formatIn(start, 'EEE, MMM d, yyyy', zone),
      detail: `${day.turbines} of ${turbineCount} ${turbineCount === 1 ? 'turbine' : 'turbines'} reporting`,
    };
  });
}
