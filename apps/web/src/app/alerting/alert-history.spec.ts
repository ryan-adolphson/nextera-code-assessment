import { reading } from '../fleet/testing';
import { fromUtcInput, groupByTurbine, last24Hours, rangeError, toUtcInput } from './alert-history';

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

describe('groupByTurbine', () => {
  const r = (id: string, turbineId: string) =>
    reading({ id, turbineId, farmId: turbineId === 'TURB001' ? 'FARM01' : 'FARM02' });
  const all = [r('a1', 'TURB001'), r('b1', 'TURB002'), r('b2', 'TURB002'), r('b3', 'TURB002')];
  const farm = (id: string) => (id === 'FARM01' ? 'Prairie Ridge' : null);
  const summary = (rows: ReturnType<typeof groupByTurbine>) =>
    rows.map((row) =>
      row.kind === 'group'
        ? `group ${row.turbineId} ${row.farmName} ${row.count}${row.continued ? ' continued' : ''}`
        : row.reading.id,
    );

  it('puts a header with the turbine’s total count before each turbine’s readings', () => {
    expect(summary(groupByTurbine(all.slice(0, 3), all, farm))).toEqual([
      'group TURB001 Prairie Ridge 1',
      'a1',
      'group TURB002 null 3',
      'b1',
      'b2',
    ]);
  });

  it('repeats the header, marked continued, when a turbine runs onto the next page', () => {
    expect(summary(groupByTurbine(all.slice(3), all, farm))).toEqual([
      'group TURB002 null 3 continued',
      'b3',
    ]);
  });

  it('has no rows for an empty page', () => {
    expect(groupByTurbine([], [], farm)).toEqual([]);
  });
});
