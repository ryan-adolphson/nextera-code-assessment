import { IsUtcTimestamp } from '@nextera/shared';

/**
 * GET /api/anomalies?from=&to=: both bounds are required, at most MAX_QUERY_RANGE_DAYS (31,
 * `@nextera/shared`) apart (checked by the shared query).
 */
export class AnomaliesQueryDto {
  /** Inclusive lower bound on the measurement timestamp (ISO 8601 date-time with a zone). */
  @IsUtcTimestamp({ allowFuture: true })
  from: string;

  /** Exclusive upper bound on the measurement timestamp; after `from`; may be in the future. */
  @IsUtcTimestamp({ allowFuture: true })
  to: string;
}
