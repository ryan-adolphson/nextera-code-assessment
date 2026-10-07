import { IsISO8601 } from 'class-validator';

/** The widest range GET /api/alerts accepts, so one request cannot pull the whole table. */
export const MAX_ALERTS_RANGE_DAYS = 31;

/** GET /api/alerts?from=&to=: both bounds are required (the web app defaults to the last 24 h). */
export class AlertsQueryDto {
  /** Inclusive lower bound on the measurement timestamp (ISO 8601). */
  @IsISO8601({ strict: true }, { message: 'from must be an ISO 8601 date' })
  from: string;

  /** Exclusive upper bound on the measurement timestamp (ISO 8601); after `from`. */
  @IsISO8601({ strict: true }, { message: 'to must be an ISO 8601 date' })
  to: string;
}
