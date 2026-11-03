import { DEFAULT_WEATHER_TIME_ZONE, IsUtcTimestamp } from '@nextera/shared';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * GET /api/farms/:farmId/telemetry/daily?from=&to=&timeZone=: a required [from, to) range on the
 * 30-minute buckets' start time, at most MAX_FARM_DAILY_RANGE_DAYS (183, `@nextera/shared`; an hour
 * more across a DST change), grouped into local days in `timeZone`. Send local midnights of that
 * zone for whole days.
 */
export class FarmDailyQueryDto {
  /** Inclusive lower bound (ISO 8601 date-time with a zone). */
  @IsUtcTimestamp({ allowFuture: true })
  from: string;

  /** Exclusive upper bound (ISO 8601 date-time with a zone); after `from`. May be in the future. */
  @IsUtcTimestamp({ allowFuture: true })
  to: string;

  /**
   * IANA zone of the days (default UTC). Only its shape is checked here; whether Postgres knows it
   * is checked by the shared query (`checkTimeZone`), which answers 400 like this would.
   */
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timeZone: string = DEFAULT_WEATHER_TIME_ZONE;
}
