import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { TurbineListQueryDto } from './turbine-list-query.dto.js';

const errors = async (query: Record<string, unknown>) =>
  (await validate(plainToInstance(TurbineListQueryDto, query))).map(
    (e) => e.property,
  );

describe('TurbineListQueryDto asOf', () => {
  it.each([
    undefined,
    '2026-01-01T12:00:00Z',
    '2026-01-01T12:00:00.123+02:00',
    '2999-01-01T00:00:00Z', // far future: no range limit
    '1990-01-01T00:00:00Z', // before the telemetry minimum: no range limit
  ])('accepts %s', async (asOf) => {
    expect(await errors({ asOf })).toEqual([]);
  });

  it.each([
    '2026-01-01',
    '2026-01-01T12:00:00', // no zone
    '2026-W01-1T12:00Z',
    '2026-02-30T12:00:00Z',
    'yesterday',
    '',
  ])('rejects %j', async (asOf) => {
    expect(await errors({ asOf })).toEqual(['asOf']);
  });
});
