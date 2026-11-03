import { TelemetryMetric } from '../fleet/fleet.model';
import {
  AlertLevel,
  describeRule,
  formatThreshold,
  levelLabel,
  metricOf,
} from './alert-config.model';

describe('alert rule wording', () => {
  it('labels each known metric with its unit', () => {
    expect(metricOf('gearboxTempC')).toEqual({
      value: 'gearboxTempC',
      label: 'Gearbox temperature',
      unit: '°C',
    });
  });

  it('falls back to the raw name, without a unit, for a metric it does not know', () => {
    // E.g. a metric the API added before this client was updated.
    expect(metricOf('nacelleYawDeg' as TelemetryMetric)).toEqual({
      value: 'nacelleYawDeg',
      label: 'nacelleYawDeg',
      unit: '',
    });
  });

  it.each([
    ['info', 'Info'],
    ['warn', 'Warning'],
    ['error', 'Error'],
  ] as const)('labels the %s level "%s"', (level, label) => {
    expect(levelLabel(level)).toBe(label);
  });

  it('falls back to the raw value for a level it does not know', () => {
    expect(levelLabel('critical' as AlertLevel)).toBe('critical');
  });

  it('writes thresholds with a space before the unit, except a bare degree sign', () => {
    expect(formatThreshold(120.5, '°C')).toBe('120.5 °C');
    expect(formatThreshold(30, '°')).toBe('30°');
    expect(formatThreshold(7, '')).toBe('7');
  });

  it('describes a rule of an unknown metric without a dangling unit', () => {
    expect(
      describeRule({
        measurementMetric: 'nacelleYawDeg' as TelemetryMetric,
        comparison: 'above',
        valueMetric: 10,
        alertLevel: 'info',
      }),
    ).toBe('nacelleYawDeg above 10');
  });
});
