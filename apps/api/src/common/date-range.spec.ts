import { BadRequestException } from '@nestjs/common';
import { assertRange } from './date-range.js';

describe('assertRange', () => {
  it('returns the parsed bounds of a forward range within the limit', () => {
    expect(
      assertRange('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z', 31),
    ).toEqual({
      start: new Date('2026-01-01T00:00:00Z'),
      end: new Date('2026-02-01T00:00:00Z'),
    });
  });

  it.each([
    [
      'equal bounds',
      '2026-01-02T00:00:00Z',
      '2026-01-02T00:00:00Z',
      'to must be after from',
    ],
    [
      'a reversed range',
      '2026-01-03T00:00:00Z',
      '2026-01-02T00:00:00Z',
      'to must be after from',
    ],
    [
      'a range over the limit',
      '2026-01-01T00:00:00Z',
      '2026-02-01T00:00:01Z',
      'The range may span at most 31 days',
    ],
  ])('rejects %s with 400', (_, from, to, message) => {
    expect(() => assertRange(from, to, 31)).toThrow(
      new BadRequestException(message),
    );
  });
});
