import { Telemetry } from '../fleet/fleet.model';
import { AlertLevel } from './alert-config.model';
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
  /** Every alert in the range: the rules each flagged reading triggered, summed. */
  alertCount: number;
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
    alertCount: group.reduce((sum, r) => sum + r.alerts.length, 0),
  }));
}
