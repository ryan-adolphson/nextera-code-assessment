import { BadRequestException, NotFoundException } from '@nestjs/common';
import { QueryInputError, QueryNotFoundError } from '@nextera/shared';
import { httpQuery, toHttpError } from './query-errors.js';

describe('toHttpError', () => {
  it('maps an unknown farm or turbine to 404 with the same message', () => {
    expect(
      toHttpError(new QueryNotFoundError('Turbine TURB999 not found')),
    ).toEqual(new NotFoundException('Turbine TURB999 not found'));
  });

  it('maps a broken data rule to 400 with the same message', () => {
    expect(toHttpError(new QueryInputError('to must be after from'))).toEqual(
      new BadRequestException('to must be after from'),
    );
  });

  it('leaves any other error to the global filters', () => {
    const error = new Error('connection refused');
    expect(toHttpError(error)).toBe(error);
  });
});

describe('httpQuery', () => {
  it('resolves with the query result', async () => {
    await expect(httpQuery(Promise.resolve([1]))).resolves.toEqual([1]);
  });

  it('rejects with the mapped error', async () => {
    await expect(
      httpQuery(
        Promise.reject(
          new QueryInputError('The range may span at most 31 days'),
        ),
      ),
    ).rejects.toThrow(
      new BadRequestException('The range may span at most 31 days'),
    );
  });
});
