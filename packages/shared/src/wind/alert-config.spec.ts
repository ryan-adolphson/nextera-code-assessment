import {
  AlertComparison,
  AlertLevel,
  MeasurementMetric,
} from '../generated/prisma/enums.js';
import { TELEMETRY_METRIC_COLUMNS, TELEMETRY_METRICS } from './responses.js';
import { ALERT_CONFIG_CHANGED, toAlertConfigResponse } from './alert-config.js';

describe('alerts_config enums', () => {
  it('MeasurementMetric has exactly one value per telemetry metric', () => {
    expect(Object.values(MeasurementMetric).sort()).toEqual(
      [...TELEMETRY_METRICS].sort(),
    );
  });

  it('every metric maps to a telemetry column (the enum values stored in Postgres)', () => {
    for (const metric of Object.values(MeasurementMetric)) {
      expect(TELEMETRY_METRIC_COLUMNS[metric]).toMatch(/^[a-z_]+$/);
    }
  });

  it('alert levels are info, warn and error; comparisons are above and below', () => {
    expect(Object.values(AlertLevel)).toEqual(['info', 'warn', 'error']);
    expect(Object.values(AlertComparison)).toEqual(['above', 'below']);
  });
});

describe('toAlertConfigResponse', () => {
  it('maps a row to the public camelCase shape with a plain number', () => {
    const response = toAlertConfigResponse({
      id: '0b3c7a1e-8f7d-4a4e-9c11-2f1d6c3b9a10',
      measurementMetric: MeasurementMetric.gearboxTempC,
      comparison: AlertComparison.above,
      valueMetric: 120.5,
      alertLevel: AlertLevel.error,
      enabled: false,
    });

    expect(response).toEqual({
      id: '0b3c7a1e-8f7d-4a4e-9c11-2f1d6c3b9a10',
      measurementMetric: 'gearboxTempC',
      comparison: 'above',
      valueMetric: 120.5,
      alertLevel: 'error',
      enabled: false,
    });
    expect(Object.keys(response)).toHaveLength(6); // nothing else leaks
  });

  it('names the change event', () => {
    expect(ALERT_CONFIG_CHANGED).toBe('alert-config.changed');
  });
});
