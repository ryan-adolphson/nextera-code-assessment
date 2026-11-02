/**
 * A farm's daily history, as GET /api/farms/:farmId/telemetry/daily returns it (mirrored by hand:
 * the web app doesn't import `@nextera/shared`). Computed by the scheduled farm rollup job from
 * 30-minute rollups, grouped by calendar day in the request's `timeZone`.
 */

/** One metric's day: the farm series' first, last, highest and lowest value (2 decimals). */
export interface Ohlc {
  open: number;
  close: number;
  high: number;
  low: number;
}

/**
 * One calendar day (in the request's zone; 23 or 25 hours on a DST day). Power is the sum over the
 * farm's turbines at each 5-minute timestamp; the other metrics are means over those that reported.
 */
export interface FarmDailyDay {
  /** YYYY-MM-DD in the request's zone. */
  date: string;
  /** Turbines that reported (the most in any of the day's half-hours). */
  turbines: number;
  readings: number;
  powerOutputKw: Ohlc;
  windSpeedMs: Ohlc;
  rotorRpm: Ohlc;
  bladePitchDeg: Ohlc;
  gearboxTempC: Ohlc;
}

export interface FarmDailyHistory {
  farmId: string;
  /** The request's [from, to) (ISO). */
  from: string;
  to: string;
  timeZone: string;
  /** The farm's turbines now. */
  turbineCount: number;
  /** When the job last computed any of these days (ISO), or null if it never has. */
  computedAt: string | null;
  /** Days with data, ascending (days without any are omitted). */
  days: FarmDailyDay[];
}

/** A daily history query: whole days [from, to) in `timeZone` (at most 183 days). */
export interface FarmDailyQuery {
  from: string;
  to: string;
  timeZone: string;
}
