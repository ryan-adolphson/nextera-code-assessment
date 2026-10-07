import { reading } from '../fleet/testing';
import { AlertConfig } from './alert-config.model';
import { describeTrigger, describeTriggerWithLevel, worstLevel } from './alert-text';

let n = 0;
const rule = (overrides: Partial<AlertConfig> = {}): AlertConfig => ({
  id: `r${n++}`,
  measurementMetric: 'gearboxTempC',
  comparison: 'above',
  valueMetric: 120,
  alertLevel: 'error',
  enabled: true,
  ...overrides,
});

describe('describeTrigger', () => {
  it('names the metric, the reading’s value with unit and the threshold', () => {
    expect(describeTrigger(reading({ gearboxTempC: 126.5 }), rule())).toBe(
      'Gearbox temperature 126.5 °C > 120',
    );
    expect(
      describeTrigger(
        reading({ powerOutputKw: 0 }),
        rule({ measurementMetric: 'powerOutputKw', comparison: 'below', valueMetric: 50 }),
      ),
    ).toBe('Power output 0 kW < 50');
    expect(
      describeTriggerWithLevel(
        reading({ bladePitchDeg: 44 }),
        rule({ measurementMetric: 'bladePitchDeg', valueMetric: 30, alertLevel: 'warn' }),
      ),
    ).toBe('Warning: Blade pitch 44° > 30');
  });
});

describe('worstLevel', () => {
  it('picks the most severe level, info when there are no rules', () => {
    const level = (alertLevel: AlertConfig['alertLevel']) => rule({ alertLevel });
    expect(worstLevel([level('info'), level('error'), level('warn')])).toBe('error');
    expect(worstLevel([level('warn'), level('info')])).toBe('warn');
    expect(worstLevel([])).toBe('info');
  });
});
