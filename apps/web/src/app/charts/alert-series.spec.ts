import { AlertConfig } from '../alerting/alert-config.model';
import { reading } from '../fleet/testing';
import { alertSeries } from './alert-series';

const rule = (overrides: Partial<AlertConfig> = {}): AlertConfig => ({
  id: 'gearbox-error',
  measurementMetric: 'gearboxTempC',
  comparison: 'above',
  valueMetric: 120,
  alertLevel: 'error',
  enabled: true,
  ...overrides,
});
const warn = rule({ id: 'gearbox-warn', valueMetric: 90, alertLevel: 'warn' });
const at = (hhmm: string) => `2026-01-02T${hhmm}:00.000Z`;

describe('alertSeries', () => {
  it('plots rules per reading and marks flagged readings by their worst level', () => {
    const series = alertSeries([
      reading({ timestamp: at('03:15') }),
      reading({ timestamp: at('03:20'), gearboxTempC: 126.5, alerts: [rule(), warn] }),
    ]);
    expect(series.points).toEqual([
      { t: Date.parse(at('03:15')), v: 0 },
      { t: Date.parse(at('03:20')), v: 2 },
    ]);
    expect(series.markers).toEqual([
      {
        t: Date.parse(at('03:20')),
        v: 2,
        level: 'error',
        lines: [
          'Error: Gearbox temperature 126.5 °C > 120',
          'Warning: Gearbox temperature 126.5 °C > 90',
        ],
      },
    ]);
  });

  it('sums a farm per time and names the turbine on each line', () => {
    const series = alertSeries(
      [
        reading({ turbineId: 'TURB002', timestamp: at('03:20'), gearboxTempC: 95, alerts: [warn] }),
        reading({
          turbineId: 'TURB009',
          timestamp: at('03:20'),
          gearboxTempC: 121,
          alerts: [rule()],
        }),
      ],
      { prefixTurbine: true },
    );
    expect(series.points).toEqual([{ t: Date.parse(at('03:20')), v: 2 }]);
    expect(series.markers[0].level).toBe('error');
    expect(series.markers[0].lines).toEqual([
      'TURB002: Warning: Gearbox temperature 95 °C > 90',
      'TURB009: Error: Gearbox temperature 121 °C > 120',
    ]);
  });

  it('is empty without readings', () => {
    expect(alertSeries([])).toEqual({ points: [], markers: [] });
  });
});
