import { reading } from '../fleet/testing';
import { AlertConfig } from './alert-config.model';
import {
  dayRange,
  defaultDays,
  groupAlertsByTurbine,
  pickerDate,
  rangeError,
  utcDayOf,
} from './alert-history';

describe('UTC days from the datepicker', () => {
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);

  it('reads a picked calendar date (a local midnight) as that UTC day, and back', () => {
    expect(utcDayOf(new Date(2026, 0, 2))).toBe(day('2026-01-02'));
    const shown = pickerDate(day('2026-01-02'));
    expect([shown.getFullYear(), shown.getMonth(), shown.getDate()]).toEqual([2026, 0, 2]);
    expect(utcDayOf(pickerDate(day('2026-12-31')))).toBe(day('2026-12-31'));
  });

  it('defaults to yesterday and today (UTC), so the last 24 hours are included', () => {
    expect(defaultDays(Date.parse('2026-01-03T00:00:30Z'))).toEqual({
      start: day('2026-01-02'),
      end: day('2026-01-03'),
    });
  });

  it('queries whole days: start 00:00 to the day after the end, 00:00 (exclusive)', () => {
    expect(dayRange(day('2026-01-02'), day('2026-01-03'))).toEqual({
      from: '2026-01-02T00:00:00.000Z',
      to: '2026-01-04T00:00:00.000Z',
    });
    // One day: that day's 24 hours.
    expect(dayRange(day('2026-01-02'), day('2026-01-02'))).toEqual({
      from: '2026-01-02T00:00:00.000Z',
      to: '2026-01-03T00:00:00.000Z',
    });
  });
});

describe('rangeError', () => {
  const day = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
  it('accepts one day up to 31 days', () => {
    expect(rangeError(day('2026-01-02'), day('2026-01-02'))).toBeNull();
    expect(rangeError(day('2026-01-01'), day('2026-01-31'))).toBeNull(); // 31 days
  });
  it.each([
    [null, day('2026-01-02'), 'Choose a start date.'],
    [day('2026-01-02'), null, 'Choose an end date.'],
    [day('2026-01-03'), day('2026-01-02'), 'The end date must not be before the start date.'],
    [day('2026-01-01'), day('2026-02-01'), 'Choose at most 31 days.'], // 32 days
  ])('explains %s → %s', (start, end, message) => {
    expect(rangeError(start, end)).toBe(message);
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

  it('takes the worst level over all of a turbine’s readings', () => {
    const [turb1, turb2] = groupAlertsByTurbine(readings, farm);
    expect([turb1.worst, turb2.worst]).toEqual(['info', 'error']); // TURB002: warn, then error+warn
  });

  it('counts every alert: the rules each reading triggered, summed', () => {
    const [turb1, turb2] = groupAlertsByTurbine(readings, farm);
    expect([turb1.alertCount, turb2.alertCount]).toEqual([1, 3]); // TURB002: 1 + 2
  });

  it('has no turbines without readings', () => {
    expect(groupAlertsByTurbine([], farm)).toEqual([]);
  });
});
