import { Telemetry } from '../fleet/fleet.model';
import { AlertConfig, AlertLevel } from './alert-config.model';
import { LEVEL_SEVERITY } from './alert-text';

/** The longest range the API accepts (GET /api/alerts): at most 31 whole days. */
export const MAX_RANGE_DAYS = 31;
const DAY_MS = 24 * 60 * 60_000;

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
  const today = Math.floor(now / DAY_MS) * DAY_MS;
  return { start: today - DAY_MS, end: today };
}

/** Whole UTC days [start 00:00, the day after end 00:00) as the API's [from, to). */
export function dayRange(start: number, end: number): { from: string; to: string } {
  return {
    from: new Date(start).toISOString(),
    to: new Date(end + DAY_MS).toISOString(),
  };
}

/**
 * Why a day range cannot be queried, or null when it can (mirrors the API's 400s). Both days are
 * UTC midnights (`utcDayOf`), or null while not chosen or not a valid date.
 */
export function rangeError(start: number | null, end: number | null): string | null {
  if (start === null) return 'Choose a start date.';
  if (end === null) return 'Choose an end date.';
  if (end < start) return 'The end date must not be before the start date.';
  if (end - start + DAY_MS > MAX_RANGE_DAYS * DAY_MS)
    return `Choose at most ${MAX_RANGE_DAYS} days.`;
  return null;
}

/** One turbine's flagged readings in the range: a summary row of the history table. */
export interface TurbineAlerts {
  turbineId: string;
  farmId: string;
  farmName: string | null;
  /** Its flagged readings, newest first (the detail row). */
  readings: Telemetry[];
  /** The newest flagged reading's measurement time (ISO). */
  latest: string;
  worst: AlertLevel;
  /** Each distinct rule that fired, worst level first, with how many readings it flagged. */
  rules: { rule: AlertConfig; count: number }[];
}

/**
 * Groups the API's readings (already by turbine, newest first) into one summary per turbine, in
 * the API's order (turbine id ascending).
 */
export function groupAlertsByTurbine(
  readings: readonly Telemetry[],
  farmNameOf: (farmId: string) => string | null,
): TurbineAlerts[] {
  const groups = new Map<string, Telemetry[]>();
  for (const r of readings) groups.set(r.turbineId, [...(groups.get(r.turbineId) ?? []), r]);
  return [...groups.values()].map((group) => {
    const rules = new Map<string, { rule: AlertConfig; count: number }>();
    for (const rule of group.flatMap((r) => r.alerts)) {
      const seen = rules.get(rule.id);
      rules.set(rule.id, { rule, count: (seen?.count ?? 0) + 1 });
    }
    const sorted = [...rules.values()].sort(
      (a, b) => LEVEL_SEVERITY[b.rule.alertLevel] - LEVEL_SEVERITY[a.rule.alertLevel],
    );
    return {
      turbineId: group[0].turbineId,
      farmId: group[0].farmId,
      farmName: farmNameOf(group[0].farmId),
      readings: group,
      latest: group[0].timestamp,
      worst: sorted[0]?.rule.alertLevel ?? 'info',
      rules: sorted,
    };
  });
}
