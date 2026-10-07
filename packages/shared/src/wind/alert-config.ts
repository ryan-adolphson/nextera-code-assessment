import type { AlertConfig } from '../generated/prisma/client.js';
import type {
  AlertComparison,
  AlertLevel,
  MeasurementMetric,
} from '../generated/prisma/enums.js';

/**
 * SSE event published by the API after an alert threshold was created, updated or deleted (after
 * the write committed), so open browsers reload the rules.
 */
export const ALERT_CONFIG_CHANGED = 'alert-config.changed';

/** Public shape of an alert threshold (API + SSE). Never expose the Prisma model directly. */
export interface AlertConfigResponse {
  id: string;
  /** Telemetry field the rule watches (the API field name, e.g. "gearboxTempC"). */
  measurementMetric: MeasurementMetric;
  comparison: AlertComparison;
  valueMetric: number;
  alertLevel: AlertLevel;
  /** Disabled rules are kept (and stay on the readings they triggered) but not evaluated. */
  enabled: boolean;
}

/** Payload of `alert-config.changed`. `config` is the stored rule (absent after a delete). */
export interface AlertConfigChangedEvent {
  action: 'created' | 'updated' | 'deleted';
  id: string;
  config?: AlertConfigResponse;
}

export function toAlertConfigResponse(row: AlertConfig): AlertConfigResponse {
  return {
    id: row.id,
    measurementMetric: row.measurementMetric,
    comparison: row.comparison,
    valueMetric: Number(row.valueMetric),
    alertLevel: row.alertLevel,
    enabled: row.enabled,
  };
}
