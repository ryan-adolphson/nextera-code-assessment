import { reading } from '../fleet/testing';
import { TelemetryMetric } from '../fleet/fleet.model';
import { AlertConfig } from './alert-config.model';
import {
  describeTrigger,
  describeTriggerWithLevel,
  triggeredRules,
  worstLevel,
} from './evaluate-alerts';

let n = 0;
const rule = (overrides: Partial<AlertConfig> = {}): AlertConfig => ({
  id: `r${n++}`,
  measurementMetric: 'gearboxTempC',
  comparison: 'above',
  valueMetric: 120,
  alertLevel: 'error',
  ...overrides,
});

describe('triggeredRules', () => {
  it('is strict for "above": equal does not trigger, anything higher does', () => {
    const above = rule({ valueMetric: 120 });
    expect(triggeredRules(reading({ gearboxTempC: 120 }), [above])).toEqual([]);
    expect(triggeredRules(reading({ gearboxTempC: 119.9 }), [above])).toEqual([]);
    expect(triggeredRules(reading({ gearboxTempC: 120.01 }), [above])).toEqual([above]);
  });

  it('is strict for "below": equal does not trigger, anything lower does', () => {
    const below = rule({
      measurementMetric: 'powerOutputKw',
      comparison: 'below',
      valueMetric: 50,
    });
    expect(triggeredRules(reading({ powerOutputKw: 50 }), [below])).toEqual([]);
    expect(triggeredRules(reading({ powerOutputKw: 50.1 }), [below])).toEqual([]);
    expect(triggeredRules(reading({ powerOutputKw: 0 }), [below])).toEqual([below]);
  });

  it.each<[TelemetryMetric, number]>([
    ['powerOutputKw', 2000],
    ['windSpeedMs', 7],
    ['rotorRpm', 12],
    ['bladePitchDeg', 4],
    ['gearboxTempC', 80],
  ])('reads the rule’s own metric (%s = %d in the reading)', (metric, value) => {
    const r = reading(); // every metric at its fixture value
    expect(
      triggeredRules(r, [rule({ measurementMetric: metric, valueMetric: value - 1 })]),
    ).toHaveLength(1);
    expect(triggeredRules(r, [rule({ measurementMetric: metric, valueMetric: value })])).toEqual(
      [],
    );
    expect(
      triggeredRules(r, [
        rule({ measurementMetric: metric, comparison: 'below', valueMetric: value + 1 }),
      ]),
    ).toHaveLength(1);
  });

  it('handles negative thresholds', () => {
    const cold = rule({ comparison: 'below', valueMetric: -20, alertLevel: 'warn' });
    expect(triggeredRules(reading({ gearboxTempC: -25 }), [cold])).toEqual([cold]);
    expect(triggeredRules(reading({ gearboxTempC: -20 }), [cold])).toEqual([]);
  });

  it('triggers nothing without a reading or without rules', () => {
    expect(triggeredRules(null, [rule()])).toEqual([]);
    expect(triggeredRules(undefined, [rule()])).toEqual([]);
    expect(triggeredRules(reading({ gearboxTempC: 500 }), [])).toEqual([]);
  });

  it('lists the worst level first, keeping the rule order within a level', () => {
    const info = rule({
      measurementMetric: 'powerOutputKw',
      comparison: 'below',
      valueMetric: 5000,
      alertLevel: 'info',
    });
    const warnA = rule({ measurementMetric: 'windSpeedMs', valueMetric: 1, alertLevel: 'warn' });
    const error = rule({ valueMetric: 50, alertLevel: 'error' });
    const warnB = rule({ measurementMetric: 'rotorRpm', valueMetric: 1, alertLevel: 'warn' });
    expect(triggeredRules(reading(), [info, warnA, error, warnB])).toEqual([
      error,
      warnA,
      warnB,
      info,
    ]);
  });
});

describe('worstLevel', () => {
  it('ranks error > warn > info, and is null without rules', () => {
    expect(worstLevel([])).toBeNull();
    expect(worstLevel([rule({ alertLevel: 'info' })])).toBe('info');
    expect(worstLevel([rule({ alertLevel: 'info' }), rule({ alertLevel: 'warn' })])).toBe('warn');
    expect(
      worstLevel([
        rule({ alertLevel: 'warn' }),
        rule({ alertLevel: 'error' }),
        rule({ alertLevel: 'info' }),
      ]),
    ).toBe('error');
  });
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
