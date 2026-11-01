import {
  DEFAULT_WEATHER_TIME_ZONE,
  IsUtcTimestamp,
  type WeatherInterval,
} from '@nextera/shared';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const WEATHER_INTERVALS: readonly WeatherInterval[] = ['30min', 'daily'];

/**
 * GET /api/farms/:farmId/weather and GET /api/turbines/:id/weather?from=&to=&interval=&timeZone=:
 * a required [from, to) range on the bucket's start time, at most MAX_QUERY_RANGE_DAYS (31,
 * `@nextera/shared`), 30-minute buckets (default) or daily (local days in `timeZone`, aggregated
 * in Postgres).
 */
export class WeatherQueryDto {
  /** Inclusive lower bound (ISO 8601 date-time with a zone). */
  @IsUtcTimestamp({ allowFuture: true })
  from: string;

  /** Exclusive upper bound (ISO 8601 date-time with a zone); after `from`. May be in the future. */
  @IsUtcTimestamp({ allowFuture: true })
  to: string;

  @IsOptional()
  @IsIn(WEATHER_INTERVALS)
  interval: WeatherInterval = '30min';

  /**
   * IANA zone of the daily buckets (default UTC). Only its shape is checked here; whether Postgres
   * knows it is checked by the shared query (`checkTimeZone`), which answers 400 like this would.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timeZone: string = DEFAULT_WEATHER_TIME_ZONE;
}
