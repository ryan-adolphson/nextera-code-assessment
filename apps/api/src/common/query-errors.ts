import { BadRequestException, NotFoundException } from '@nestjs/common';
import { QueryInputError, QueryNotFoundError } from '@nextera/shared';

/**
 * The HTTP form of the shared read queries' errors: QueryNotFoundError → 404, QueryInputError →
 * 400, with the same message. Anything else (database failures) is returned as it is, for the
 * global filters.
 */
export function toHttpError(error: unknown): unknown {
  if (error instanceof QueryNotFoundError) {
    return new NotFoundException(error.message);
  }
  if (error instanceof QueryInputError) {
    return new BadRequestException(error.message);
  }
  return error;
}

/** Awaits a shared read query, rethrowing its errors as `toHttpError` maps them. */
export async function httpQuery<T>(query: Promise<T>): Promise<T> {
  try {
    return await query;
  } catch (error) {
    throw toHttpError(error);
  }
}
