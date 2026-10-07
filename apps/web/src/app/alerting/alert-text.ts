import { Telemetry } from '../fleet/fleet.model';
import {
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
