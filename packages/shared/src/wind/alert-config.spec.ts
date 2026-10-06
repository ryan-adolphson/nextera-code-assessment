import {
  AlertComparison,
  AlertLevel,
  MeasurementMetric,
} from '../generated/prisma/enums.js';
import { TELEMETRY_METRIC_COLUMNS, TELEMETRY_METRICS } from './responses.js';

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
