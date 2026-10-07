import type { AlertConfig, Telemetry } from '../generated/prisma/client.js';
import { AlertLevel, MeasurementMetric } from '../generated/prisma/enums.js';

const SEVERITY = Object.fromEntries(
  Object.values(AlertLevel).map((level, i) => [level, i]),
) as Record<AlertLevel, number>;
const METRIC_ORDER = Object.values(MeasurementMetric);

/** The telemetry values a rule can watch (MeasurementMetric names equal the Telemetry fields). */
export type AlertableReading = Pick<Telemetry, MeasurementMetric>;

/**
 * The enabled rules a reading triggers, worst first (see `compareAlertsWorstFirst`).
 * Comparisons are STRICT, like the web app's evaluator: "above 120" fires for 120.1, not for 120;
 * "below 50" fires for 49.9, not for 50. Disabled rules never fire.
 */
export function triggeredAlerts(
  reading: AlertableReading,
  rules: readonly AlertConfig[],
): AlertConfig[] {
  return rules
    .filter((rule) => {
      if (!rule.enabled) return false;
      const value = reading[rule.measurementMetric];
      return rule.comparison === 'above'
        ? value > rule.valueMetric
        : value < rule.valueMetric;
    })
    .sort(compareAlertsWorstFirst);
}

/** Worst level first (error, warn, info), then telemetry column order, then threshold, then id. */
export function compareAlertsWorstFirst(
  a: AlertConfig,
  b: AlertConfig,
): number {
  return (
    SEVERITY[b.alertLevel] - SEVERITY[a.alertLevel] ||
    METRIC_ORDER.indexOf(a.measurementMetric) -
      METRIC_ORDER.indexOf(b.measurementMetric) ||
    a.valueMetric - b.valueMetric ||
    a.id.localeCompare(b.id)
  );
}
