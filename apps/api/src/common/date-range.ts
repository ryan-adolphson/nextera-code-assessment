import { BadRequestException } from '@nestjs/common';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Parses a [from, to) range of ISO dates (already validated as ISO 8601 by the DTO) and rejects an
 * empty or reversed range, or one longer than `maxDays`, with 400.
 */
export function assertRange(
  from: string,
  to: string,
  maxDays: number,
): { start: Date; end: Date } {
  const start = new Date(from);
  const end = new Date(to);
  if (end <= start) throw new BadRequestException('to must be after from');
  if (end.getTime() - start.getTime() > maxDays * DAY_MS) {
    throw new BadRequestException(`The range may span at most ${maxDays} days`);
  }
  return { start, end };
}
