import { IsUtcTimestamp } from '@nextera/shared';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * GET /api/reports/telemetry?farmId=|turbineId=&from=&to=: exactly one of farmId (e.g. "FARM01")
 * or turbineId (the business key, e.g. "TURB001"), and a required [from, to) range of at most
 * MAX_QUERY_RANGE_DAYS (31, `@nextera/shared`; the web app picks whole UTC days).
 */
export class ReportQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  farmId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  turbineId?: string;

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
