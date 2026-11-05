import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { EventsQueryDto, MAX_SCOPED_TURBINES } from './events-query.dto.js';

const parse = (turbines?: string) => {
  const dto = plainToInstance(EventsQueryDto, { turbines });
  return { dto, errors: validateSync(dto, { whitelist: true }) };
};

describe('EventsQueryDto', () => {
  it('splits, dedupes and accepts up to the maximum', () => {
    const { dto, errors } = parse('TURB001,TURB002,TURB001');
    expect(errors).toEqual([]);
    expect(dto.turbines).toEqual(['TURB001', 'TURB002']);

    const max = Array.from({ length: MAX_SCOPED_TURBINES }, (_, i) => `T${i}`);
    expect(parse(max.join(',')).errors).toEqual([]);
  });

  it('treats a missing or empty param as none', () => {
    expect(parse(undefined).dto.turbines).toBeUndefined();
    const { dto, errors } = parse('');
    expect(errors).toEqual([]);
    expect(dto.turbines).toEqual([]);
  });

  it.each([
    ['too many', Array.from({ length: 101 }, (_, i) => `T${i}`).join(',')],
    ['an empty entry', 'TURB001,,TURB002'],
    ['a trailing comma', 'TURB001,'],
    ['a space', 'TURB001, TURB002'],
    ['a channel-like id', 'a:b'],
    ['a glob', 'TURB*'],
    ['a too long id', 'x'.repeat(65)],
  ])('rejects %s', (_name, value) => {
    expect(parse(value).errors).not.toEqual([]);
  });
});
