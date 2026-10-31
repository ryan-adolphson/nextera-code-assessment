import { IsUtcTimestamp, type WeatherInterval } from '@nextera/shared';
import { IsIn, IsOptional } from 'class-validator';

export const WEATHER_INTERVALS: readonly WeatherInterval[] = [
  'hourly',
  'daily',
];

/**
 * GET /api/farms/:farmId/weather?from=&to=&interval=: a required [from, to) range on the hour's
 * start time, at most MAX_QUERY_RANGE_DAYS (31, `@nextera/shared`), hourly (default) or daily
 * (UTC days aggregated in Postgres).
 */
export class FarmWeatherQueryDto {
  /** Inclusive lower bound (ISO 8601 date-time with a zone). */
  @IsUtcTimestamp({ allowFuture: true })
  from: string;

  /** Exclusive upper bound (ISO 8601 date-time with a zone); after `from`. May be in the future. */
  @IsUtcTimestamp({ allowFuture: true })
  to: string;

  @IsOptional()
  @IsIn(WEATHER_INTERVALS)
  interval: WeatherInterval = 'hourly';
}
