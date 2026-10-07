import { IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

/** The widest report range: at most 31 days (the web app picks whole UTC days). */
export const MAX_REPORT_RANGE_DAYS = 31;

/**
 * GET /api/reports/telemetry?farmId=|turbineId=&from=&to=: exactly one of farmId (e.g. "FARM01")
 * or turbineId (the business key, e.g. "TURB001"), and a required [from, to) range.
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

  /** Inclusive lower bound on the measurement timestamp (ISO 8601). */
  @IsISO8601({ strict: true }, { message: 'from must be an ISO 8601 date' })
  from: string;

  /** Exclusive upper bound on the measurement timestamp (ISO 8601); after `from`. */
  @IsISO8601({ strict: true }, { message: 'to must be an ISO 8601 date' })
  to: string;
}
