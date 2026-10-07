import { TelemetryMetric } from '../fleet/fleet.model';

export type AlertComparison = 'above' | 'below';
export type AlertLevel = 'info' | 'warn' | 'error';

/** Mirrors AlertConfigResponse in packages/shared (GET/POST/PATCH /api/alert-configs). */
export interface AlertConfig {
  id: string;
  measurementMetric: TelemetryMetric;
  comparison: AlertComparison;
  valueMetric: number;
  alertLevel: AlertLevel;
  /** Disabled rules are kept (and stay on the readings they triggered) but never evaluated. */
  enabled: boolean;
}

/**
 * The fields the rule editor writes (POST body; PATCH sends them all too). Not `enabled`: a new
 * rule gets the API default (true) and editing a rule leaves it as it is.
 */
export type AlertConfigInput = Omit<AlertConfig, 'id' | 'enabled'>;

/** SSE event the API publishes after every committed alert-config write (ALERT_CONFIG_CHANGED). */
export const ALERT_CONFIG_CHANGED = 'alert-config.changed';

/** Metrics in telemetry column order (the API lists rules in this order), with display units. */
export const ALERT_METRICS: readonly { value: TelemetryMetric; label: string; unit: string }[] = [
  { value: 'powerOutputKw', label: 'Power output', unit: 'kW' },
  { value: 'windSpeedMs', label: 'Wind speed', unit: 'm/s' },
  { value: 'rotorRpm', label: 'Rotor speed', unit: 'rpm' },
  { value: 'bladePitchDeg', label: 'Blade pitch', unit: '°' },
  { value: 'gearboxTempC', label: 'Gearbox temperature', unit: '°C' },
];

export const ALERT_COMPARISONS: readonly { value: AlertComparison; label: string }[] = [
  { value: 'above', label: 'above' },
  { value: 'below', label: 'below' },
];

/** Least to most severe. */
export const ALERT_RULE_LEVELS: readonly { value: AlertLevel; label: string }[] = [
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warning' },
  { value: 'error', label: 'Error' },
];

export function metricOf(metric: TelemetryMetric) {
  return (
    ALERT_METRICS.find((m) => m.value === metric) ?? { value: metric, label: metric, unit: '' }
  );
}

export function levelLabel(level: AlertLevel): string {
  return ALERT_RULE_LEVELS.find((l) => l.value === level)?.label ?? level;
}

/** "120.5 °C" (no space before a bare degree sign: "12°"). */
export function formatThreshold(value: number, unit: string): string {
  return unit === '°' ? `${value}°` : `${value} ${unit}`.trim();
}

/** "Gearbox temperature above 120.5 °C": names a rule in buttons and dialogs. */
export function describeRule(rule: AlertConfigInput): string {
  const metric = metricOf(rule.measurementMetric);
  return `${metric.label} ${rule.comparison} ${formatThreshold(rule.valueMetric, metric.unit)}`;
}

/** "Error: Gearbox temperature above 120 °C": a rule with its level (lists that mix levels). */
export function describeRuleWithLevel(rule: AlertConfigInput): string {
  return `${levelLabel(rule.alertLevel)}: ${describeRule(rule)}`;
}
