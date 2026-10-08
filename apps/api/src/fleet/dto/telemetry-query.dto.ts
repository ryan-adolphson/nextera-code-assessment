import { Type } from 'class-transformer';
import {
  DEFAULT_TELEMETRY_LIMIT,
  IsUtcTimestamp,
  MAX_TELEMETRY_LIMIT,
} from '@nextera/shared';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

export class TelemetryQueryDto {
  /** Inclusive lower bound on the measurement timestamp (ISO 8601 date-time with a zone). */
  @IsOptional()
  @IsUtcTimestamp({ allowFuture: true })
  from?: string;

  /**
   * Exclusive upper bound on the measurement timestamp (ISO 8601 date-time with a zone). May be in
   * the future (the turbine page's window ends at the client clock).
   */
  @IsOptional()
  @IsUtcTimestamp({ allowFuture: true })
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_TELEMETRY_LIMIT)
  limit: number = DEFAULT_TELEMETRY_LIMIT;
}
