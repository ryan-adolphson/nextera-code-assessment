import { Type } from 'class-transformer';
import { IsISO8601, IsInt, IsOptional, Max, Min } from 'class-validator';

/** 288 readings = 24 hours at the 5-minute reporting interval. */
export const DEFAULT_TELEMETRY_LIMIT = 288;
export const MAX_TELEMETRY_LIMIT = 2016; // 7 days

export class TelemetryQueryDto {
  /** Inclusive lower bound on the measurement timestamp (ISO 8601). */
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  /** Exclusive upper bound on the measurement timestamp (ISO 8601). */
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_TELEMETRY_LIMIT)
  limit: number = DEFAULT_TELEMETRY_LIMIT;
}
