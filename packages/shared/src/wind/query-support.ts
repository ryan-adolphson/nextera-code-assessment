import type { Prisma } from '../generated/prisma/client.js';

/**
 * What every read query shares: the client type, the errors the queries throw on purpose and the
 * range rules. (Their own module so the query files can import each other's helpers without a cycle.)
 */
export type ReadClient = Prisma.TransactionClient;

/** The widest [from, to) range of the alert and report queries, so one call can't pull the table. */
export const MAX_QUERY_RANGE_DAYS = 31;

const DAY_MS = 24 * 60 * 60 * 1000;

/** A required [from, to) range on measurement time (ISO instants), at most 31 days. */
export interface TimeRange {
  from: string;
  to: string;
}

/** Base class of the errors the read queries throw on purpose (never for database failures). */
export class QueryError extends Error {}
/** An unknown farm or turbine (the API answers 404). */
export class QueryNotFoundError extends QueryError {
  override readonly name = 'QueryNotFoundError';
}
/** Arguments that break a data rule, e.g. a reversed or too long range (the API answers 400). */
export class QueryInputError extends QueryError {
  override readonly name = 'QueryInputError';
}

/** The result would be too large to serve (the API answers 413). */
export class QueryTooLargeError extends QueryError {
  override readonly name = 'QueryTooLargeError';
}

/**
 * Parses a [from, to) range of ISO instants (already validated as timestamps by the caller) and
 * rejects an empty or reversed range, or one longer than `maxDays`.
 */
export function parseRange(
  from: string,
  to: string,
  maxDays: number = MAX_QUERY_RANGE_DAYS,
): { start: Date; end: Date } {
  const start = new Date(from);
  const end = new Date(to);
  if (end <= start) throw new QueryInputError('to must be after from');
  if (end.getTime() - start.getTime() > maxDays * DAY_MS) {
    throw new QueryInputError(`The range may span at most ${maxDays} days`);
  }
  return { start, end };
}
