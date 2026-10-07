import { reading } from '../fleet/testing';
import { AlertConfig } from './alert-config.model';
import {
  fromUtcInput,
  groupAlertsByTurbine,
  last24Hours,
  rangeError,
  toUtcInput,
} from './alert-history';

describe('UTC datetime-local values', () => {
  it('round-trips an instant at minute precision, in UTC', () => {
    const ms = Date.parse('2026-01-02T03:25:00Z');
    expect(toUtcInput(ms)).toBe('2026-01-02T03:25');
    expect(fromUtcInput('2026-01-02T03:25')).toBe(ms);
  });

  it('rejects empty or malformed values', () => {
    expect(fromUtcInput('')).toBeNull();
    expect(fromUtcInput('2026-01-02')).toBeNull();
    expect(fromUtcInput('2026-13-45T99:99')).toBeNull();
  });
});

describe('last24Hours', () => {
  it('ends at the next whole minute (so now is included) and starts 24 h earlier', () => {
    const { from, to } = last24Hours(Date.parse('2026-01-03T00:00:30Z'));
    expect(new Date(to).toISOString()).toBe('2026-01-03T00:01:00.000Z');
    expect(new Date(from).toISOString()).toBe('2026-01-02T00:01:00.000Z');
  });
});

describe('rangeError', () => {
  const at = (iso: string) => Date.parse(iso);
  it('accepts a forward range of up to 31 days', () => {
    expect(rangeError(at('2026-01-01T00:00Z'), at('2026-02-01T00:00Z'))).toBeNull();
  });
  it.each([
    [null, at('2026-01-02T00:00Z'), 'Enter a valid start date and time.'],
    [at('2026-01-02T00:00Z'), null, 'Enter a valid end date and time.'],
    [at('2026-01-02T00:00Z'), at('2026-01-02T00:00Z'), 'The end must be after the start.'],
    [at('2026-01-01T00:00Z'), at('2026-02-01T00:01Z'), 'Choose at most 31 days.'],
  ])('explains %s → %s', (from, to, message) => {
    expect(rangeError(from, to)).toBe(message);
  });
});

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

  it('lists each distinct rule once, worst first, with how many readings it flagged', () => {
    const [, turb2] = groupAlertsByTurbine(readings, farm);
    expect(turb2.rules.map((r) => [r.rule.id, r.count])).toEqual([
      ['error', 1],
      ['warn', 2],
    ]);
  });

  it('has no turbines without readings', () => {
    expect(groupAlertsByTurbine([], farm)).toEqual([]);
  });
});
