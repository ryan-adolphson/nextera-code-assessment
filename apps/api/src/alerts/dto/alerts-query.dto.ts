import { IsUtcTimestamp } from '@nextera/shared';

/**
 * GET /api/alerts?from=&to=: both bounds are required (the web app defaults to the last 24 h). The
 * range may span at most MAX_QUERY_RANGE_DAYS (31, `@nextera/shared`), so one request cannot pull
 * the whole table.
 */
export class AlertsQueryDto {
  /** Inclusive lower bound on the measurement timestamp (ISO 8601 date-time with a zone). */
  @IsUtcTimestamp({ allowFuture: true })
  from: string;

  /**
   * Exclusive upper bound on the measurement timestamp (ISO 8601 date-time with a zone); after
   * `from`. May be in the future (whole UTC days end at tomorrow 00:00Z).
   */
  @IsUtcTimestamp({ allowFuture: true })
  to: string;
}
