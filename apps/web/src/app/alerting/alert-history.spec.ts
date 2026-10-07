import { reading } from '../fleet/testing';
import { AlertConfig } from './alert-config.model';
import { groupAlertsByTurbine } from './alert-history';

describe('groupAlertsByTurbine', () => {
  const rule = (id: string, alertLevel: AlertConfig['alertLevel']): AlertConfig => ({
    id,
    measurementMetric: 'gearboxTempC',
    comparison: 'above',
    valueMetric: 1,
    alertLevel,
    enabled: true,
  });
  const info = rule('info', 'info');
  const warn = rule('warn', 'warn');
  const error = rule('error', 'error');
  // As the API returns them: by turbine, newest first.
  const readings = [
    reading({ id: 'a1', timestamp: '2026-01-02T13:40:00.000Z', alerts: [info] }),
    reading({
      id: 'b1',
      turbineId: 'TURB002',
      farmId: 'FARM02',
      timestamp: '2026-01-02T03:30:00.000Z',
      alerts: [warn],
    }),
    reading({
      id: 'b2',
      turbineId: 'TURB002',
      farmId: 'FARM02',
      timestamp: '2026-01-02T03:25:00.000Z',
      alerts: [error, warn],
    }),
  ];
  const farm = (id: string) => (id === 'FARM01' ? 'Prairie Ridge' : null);

  it('summarises each turbine in the API order: readings, latest, worst level', () => {
    const groups = groupAlertsByTurbine(readings, farm);
    expect(
      groups.map((g) => [g.turbineId, g.farmName, g.readings.map((r) => r.id), g.latest, g.worst]),
    ).toEqual([
      ['TURB001', 'Prairie Ridge', ['a1'], '2026-01-02T13:40:00.000Z', 'info'],
      ['TURB002', null, ['b1', 'b2'], '2026-01-02T03:30:00.000Z', 'error'],
    ]);
  });

  it('takes the worst level over all of a turbine’s readings', () => {
    const [turb1, turb2] = groupAlertsByTurbine(readings, farm);
    expect([turb1.worst, turb2.worst]).toEqual(['info', 'error']); // TURB002: warn, then error+warn
  });

  it('counts every alert per level, worst first, only the levels triggered', () => {
    const [turb1, turb2] = groupAlertsByTurbine(readings, farm);
    expect(turb1.levelCounts).toEqual([{ level: 'info', count: 1 }]);
    // TURB002: warn, then error + warn
    expect(turb2.levelCounts).toEqual([
      { level: 'error', count: 1 },
      { level: 'warn', count: 2 },
    ]);
  });

  it('has no turbines without readings', () => {
    expect(groupAlertsByTurbine([], farm)).toEqual([]);
  });
});
