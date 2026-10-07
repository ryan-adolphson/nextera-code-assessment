import { Telemetry } from '../fleet/fleet.model';
import { ALERT_RULE_LEVELS, AlertLevel } from './alert-config.model';
import { worstLevel } from './alert-text';

/** One turbine's flagged readings in the range: a summary row of the history table. */
export interface TurbineAlerts {
  turbineId: string;
  farmId: string;
  farmName: string | null;
  /** Its flagged readings, newest first (the detail row). */
  readings: Telemetry[];
  /** The newest flagged reading's measurement time (ISO). */
  latest: string;
  /** The worst level any of its readings triggered (the summary row's `data-level`). */
  worst: AlertLevel;
  /**
   * Its alerts in the range per level (the rules each flagged reading triggered, summed), worst
   * level first; only the levels it triggered.
   */
  levelCounts: { level: AlertLevel; count: number }[];
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
  return [...groups.values()].map((group) => ({
    turbineId: group[0].turbineId,
    farmId: group[0].farmId,
    farmName: farmNameOf(group[0].farmId),
    readings: group,
    latest: group[0].timestamp,
    worst: worstLevel(group.flatMap((r) => r.alerts)),
    levelCounts: countByLevel(group),
  }));
}

function countByLevel(readings: readonly Telemetry[]): TurbineAlerts['levelCounts'] {
  const alerts = readings.flatMap((r) => r.alerts);
  return [...ALERT_RULE_LEVELS]
    .reverse()
    .map(({ value }) => ({
      level: value,
      count: alerts.filter((a) => a.alertLevel === value).length,
    }))
    .filter(({ count }) => count > 0);
}
