/**
 * Open-Meteo weather of a farm, as GET /api/farms/:farmId/weather returns it. Mirrors the API's
 * weather responses by hand: the web app doesn't import `@nextera/shared`.
 */

/** `30min`: half-hour buckets (UTC); `daily`: calendar days in the request's `timeZone`. */
export type WeatherInterval = '30min' | 'daily';

/** One 30-minute bucket. Every metric may be null (not synced, or not reported by Open-Meteo). */
export interface WeatherSlot {
  /** Start of the bucket (ISO, UTC; :00 or :30). */
  time: string;
  /** Open-Meteo samples in the bucket (0–2). */
  samples: number;
  windSpeed10mMs: number | null;
  windSpeed80mMs: number | null;
  windDirection10mDeg: number | null;
  windDirection80mDeg: number | null;
  windGusts10mMs: number | null;
  temperature2mC: number | null;
  relativeHumidity2mPct: number | null;
  surfacePressureHpa: number | null;
  /** Sum over the 30 minutes. */
  precipitationMm: number | null;
  cloudCoverPct: number | null;
}

/** One calendar day (in the request's `timeZone`), aggregated from its 30-minute buckets. */
export interface WeatherDay {
  /** The day (YYYY-MM-DD) in the request's zone. */
  date: string;
  /** 30-minute buckets stored for the day (48 for a complete day; 46/50 on a DST day). */
  samples: number;
  windSpeed10mMeanMs: number | null;
  windSpeed10mMaxMs: number | null;
  windSpeed80mMeanMs: number | null;
  windSpeed80mMaxMs: number | null;
  windDirection80mDeg: number | null;
  windGusts10mMaxMs: number | null;
  temperature2mMinC: number | null;
  temperature2mMaxC: number | null;
  temperature2mMeanC: number | null;
  relativeHumidity2mMeanPct: number | null;
  surfacePressureMeanHpa: number | null;
  precipitationSumMm: number | null;
  cloudCoverMeanPct: number | null;
}

interface PointsOf {
  '30min': WeatherSlot[];
  daily: WeatherDay[];
}

/** A weather query: [from, to) (ISO, at most 31 × 24 h); `timeZone` (IANA) names the days of `daily`. */
export interface WeatherQuery<I extends WeatherInterval = WeatherInterval> {
  from: string;
  to: string;
  interval: I;
  timeZone?: string;
}

/** The response body. */
export interface WeatherResponse<I extends WeatherInterval = WeatherInterval> {
  farmId: string;
  from: string;
  to: string;
  interval: I;
  timeZone: string;
  points: PointsOf[I];
}
