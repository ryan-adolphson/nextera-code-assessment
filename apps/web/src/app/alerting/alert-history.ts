import { Telemetry } from '../fleet/fleet.model';
import { AlertConfig, AlertLevel } from './alert-config.model';
import { LEVEL_SEVERITY } from './evaluate-alerts';

/** The longest range the API accepts (GET /api/alerts). */
export const MAX_RANGE_DAYS = 31;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** A `datetime-local` value ("2026-01-02T03:25") for an instant, in UTC (the app shows UTC). */
export function toUtcInput(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16);
}

/** The instant of a UTC `datetime-local` value, or null when empty or invalid. */
export function fromUtcInput(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}:00Z`);
  return Number.isNaN(ms) ? null : ms;
}

/** The default range: the last 24 hours, `to` rounded up to the next minute so "now" is included. */
export function last24Hours(now: number): { from: number; to: number } {
  const to = Math.ceil(now / MINUTE_MS) * MINUTE_MS;
  return { from: to - DAY_MS, to };
}

/** Why a range cannot be queried, or null when it can (mirrors the API's 400s). */
export function rangeError(from: number | null, to: number | null): string | null {
  if (from === null) return 'Enter a valid start date and time.';
  if (to === null) return 'Enter a valid end date and time.';
  if (to <= from) return 'The end must be after the start.';
  if (to - from > MAX_RANGE_DAYS * DAY_MS) return `Choose at most ${MAX_RANGE_DAYS} days.`;
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
