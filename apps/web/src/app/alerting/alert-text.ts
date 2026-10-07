import { Telemetry } from '../fleet/fleet.model';
import {
  ALERT_RULE_LEVELS,
  AlertConfig,
  AlertLevel,
  formatThreshold,
  levelLabel,
  metricOf,
} from './alert-config.model';

/**
 * Alert descriptions for the UI (rules are evaluated by ingestion, see telemetry_alerts).
 * LEVEL_SEVERITY: higher is worse.
 */
export const LEVEL_SEVERITY: Record<AlertLevel, number> = { info: 1, warn: 2, error: 3 };

/** The most severe level among `rules` (info when there are none). */
export function worstLevel(rules: readonly AlertConfig[]): AlertLevel {
  return rules.reduce<AlertLevel>(
    (worst, rule) =>
      LEVEL_SEVERITY[rule.alertLevel] > LEVEL_SEVERITY[worst] ? rule.alertLevel : worst,
    'info',
  );
}

/** How many triggered rules of one level (a "Warning: 2" pill). */
export interface LevelCount {
  level: AlertLevel;
  count: number;
}

/**
 * The triggered `rules` counted per level: only the levels present, worst first. Pass one
 * reading's `alerts`, or several readings' flattened (`readings.flatMap((r) => r.alerts)`).
 */
export function countByLevel(rules: readonly AlertConfig[]): LevelCount[] {
  return [...ALERT_RULE_LEVELS]
    .sort((a, b) => LEVEL_SEVERITY[b.value] - LEVEL_SEVERITY[a.value])
    .map(({ value }) => ({
      level: value,
      count: rules.filter((rule) => rule.alertLevel === value).length,
    }))
    .filter(({ count }) => count > 0);
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
