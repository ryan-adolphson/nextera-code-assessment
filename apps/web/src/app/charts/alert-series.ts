import { describeTriggerWithLevel, worstLevel } from '../alerting/alert-text';
import { Telemetry } from '../fleet/fleet.model';
import { ChartMarker } from './line-chart';
import { ChartPoint } from './scales';

/** The "Alert rules triggered" chart: a line of alerts per time and the flagged times as markers. */
export interface AlertSeries {
  /** Rules triggered per measurement time (summed over the turbines at that time). */
  points: ChartPoint[];
  /** The times with alerts, coloured by the worst level; their lines list every rule. */
  markers: ChartMarker[];
}

/**
 * The alerts chart for readings in time order: one point per measurement time (a single turbine
 * has one reading per time). With `prefixTurbine` (a farm), each line names its turbine.
 */
export function alertSeries(
  readings: readonly Telemetry[],
  { prefixTurbine = false }: { prefixTurbine?: boolean } = {},
): AlertSeries {
  const byTime = new Map<number, Telemetry[]>();
  for (const r of readings) {
    const t = Date.parse(r.timestamp);
    byTime.set(t, [...(byTime.get(t) ?? []), r]);
  }
  const times = [...byTime.keys()].sort((a, b) => a - b);
  return {
    points: times.map((t) => ({
      t,
      v: byTime.get(t)!.reduce((n, r) => n + r.alerts.length, 0),
    })),
    markers: times.flatMap((t): ChartMarker[] => {
      const flagged = byTime.get(t)!.filter((r) => r.alerts.length);
      if (!flagged.length) return [];
      const rules = flagged.flatMap((r) => r.alerts);
      return [
        {
          t,
          v: rules.length,
          level: worstLevel(rules),
          lines: flagged.flatMap((r) =>
            r.alerts.map(
              (rule) =>
                `${prefixTurbine ? `${r.turbineId}: ` : ''}${describeTriggerWithLevel(r, rule)}`,
            ),
          ),
        },
      ];
    }),
  };
}
