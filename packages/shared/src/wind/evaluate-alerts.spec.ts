import type { AlertConfig } from '../generated/prisma/client.js';
import {
  compareAlertsWorstFirst,
  triggeredAlerts,
  type AlertableReading,
} from './evaluate-alerts.js';

const reading = (
  overrides: Partial<AlertableReading> = {},
): AlertableReading => ({
  powerOutputKw: 2000,
  windSpeedMs: 8,
  rotorRpm: 12,
  bladePitchDeg: 4,
  gearboxTempC: 80,
  ...overrides,
});

let n = 0;
const rule = (overrides: Partial<AlertConfig> = {}): AlertConfig => ({
  id: `00000000-0000-4000-8000-00000000000${n++}`,
  measurementMetric: 'gearboxTempC',
  comparison: 'above',
  valueMetric: 120,
  alertLevel: 'error',
  enabled: true,
  ...overrides,
});

describe('triggeredAlerts', () => {
  it('is strict: equal to the threshold does not trigger', () => {
    const above = rule({ valueMetric: 120 });
    const below = rule({
      measurementMetric: 'powerOutputKw',
      comparison: 'below',
      valueMetric: 100,
    });
    expect(triggeredAlerts(reading({ gearboxTempC: 120 }), [above])).toEqual(
      [],
    );
    expect(triggeredAlerts(reading({ gearboxTempC: 120.1 }), [above])).toEqual([
      above,
    ]);
    expect(triggeredAlerts(reading({ powerOutputKw: 100 }), [below])).toEqual(
      [],
    );
    expect(triggeredAlerts(reading({ powerOutputKw: 99.9 }), [below])).toEqual([
      below,
    ]);
  });

  it('watches the rule’s own metric, and never fires a disabled rule', () => {
    const wind = rule({ measurementMetric: 'windSpeedMs', valueMetric: 25 });
    const off = rule({ valueMetric: 50, enabled: false });
    expect(
      triggeredAlerts(reading({ gearboxTempC: 130, windSpeedMs: 10 }), [
        wind,
        off,
      ]),
    ).toEqual([]);
  });

  it('returns every triggered rule, worst level first', () => {
    const info = rule({ valueMetric: 60, alertLevel: 'info' });
    const warn = rule({ valueMetric: 90, alertLevel: 'warn' });
    const error = rule({ valueMetric: 120, alertLevel: 'error' });
    expect(
      triggeredAlerts(reading({ gearboxTempC: 126.5 }), [info, warn, error]),
    ).toEqual([error, warn, info]);
  });
});

describe('compareAlertsWorstFirst', () => {
  it('orders by level, then telemetry column order, then threshold', () => {
    const gearboxWarn = rule({ alertLevel: 'warn', valueMetric: 90 });
    const powerWarn = rule({
      alertLevel: 'warn',
      measurementMetric: 'powerOutputKw',
      comparison: 'below',
      valueMetric: 50,
    });
    const powerWarnHigher = rule({ ...powerWarn, id: 'z', valueMetric: 80 });
    const info = rule({ alertLevel: 'info' });
    expect(
      [info, gearboxWarn, powerWarnHigher, powerWarn].sort(
        compareAlertsWorstFirst,
      ),
    ).toEqual([powerWarn, powerWarnHigher, gearboxWarn, info]);
  });
});
