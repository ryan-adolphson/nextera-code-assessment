import { Telemetry } from '../fleet/fleet.model';
import {
  AlertConfig,
  AlertLevel,
  formatThreshold,
  levelLabel,
  metricOf,
} from './alert-config.model';

/** Higher is worse. */
export const LEVEL_SEVERITY: Record<AlertLevel, number> = { info: 1, warn: 2, error: 3 };

/**
 * The rules a reading triggers, worst level first (then in the given rule order, which the API
 * returns by metric). Comparisons are STRICT: "above 120" fires for 120.1, not for 120 exactly;
 * "below 50" fires for 49.9, not for 50. No reading triggers nothing.
 */
export function triggeredRules(
  reading: Telemetry | null | undefined,
  rules: readonly AlertConfig[],
): AlertConfig[] {
  if (!reading) return [];
  return rules
    .filter((rule) => {
      const value = reading[rule.measurementMetric];
      return rule.comparison === 'above' ? value > rule.valueMetric : value < rule.valueMetric;
    })
    .map((rule, index) => ({ rule, index }))
    .sort(
      (a, b) =>
        LEVEL_SEVERITY[b.rule.alertLevel] - LEVEL_SEVERITY[a.rule.alertLevel] || a.index - b.index,
    )
    .map(({ rule }) => rule);
}

/** The most severe level among `rules` (error > warn > info); null when there are none. */
export function worstLevel(rules: readonly AlertConfig[]): AlertLevel | null {
  let worst: AlertLevel | null = null;
  for (const { alertLevel } of rules) {
    if (!worst || LEVEL_SEVERITY[alertLevel] > LEVEL_SEVERITY[worst]) worst = alertLevel;
  }
  return worst;
}

/** "Gearbox temperature 126.5 °C > 120": the reading's value against the rule's threshold. */
export function describeTrigger(reading: Telemetry, rule: AlertConfig): string {
  const metric = metricOf(rule.measurementMetric);
  const value = formatThreshold(reading[rule.measurementMetric], metric.unit);
  return `${metric.label} ${value} ${rule.comparison === 'above' ? '>' : '<'} ${rule.valueMetric}`;
}

/** "Warning: Rotor speed 18 rpm > 15" (for lists that mix levels). */
export function describeTriggerWithLevel(reading: Telemetry, rule: AlertConfig): string {
  return `${levelLabel(rule.alertLevel)}: ${describeTrigger(reading, rule)}`;
}
