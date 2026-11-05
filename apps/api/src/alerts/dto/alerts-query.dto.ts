import { Type } from 'class-transformer';
import {
  DEFAULT_ALERT_PAGE,
  IsUtcTimestamp,
  MAX_ALERT_PAGE,
} from '@nextera/shared';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * GET /api/alerts?from=&to=&limit=&cursor=: both bounds are required (the web app defaults to the
 * last 24 h). The range may span at most MAX_QUERY_RANGE_DAYS (31, `@nextera/shared`), so one
 * request cannot pull the whole table; the flagged readings come in pages.
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

  /** Flagged readings per page, newest first. */
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_ALERT_PAGE)
  limit: number = DEFAULT_ALERT_PAGE;

  /** The previous page's `nextCursor`. */
  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string;
}
