import type {
  AlertConfig,
  Farm,
  FarmWeatherHourly,
  Prisma,
  Telemetry,
  Turbine,
} from '../generated/prisma/client.js';
import type { WeatherSource } from '../generated/prisma/enums.js';
import {
  toAlertConfigResponse,
  type AlertConfigResponse,
} from './alert-config.js';
import { compareAlertsWorstFirst } from './evaluate-alerts.js';

/** SSE event published by the ingestion worker for every newly stored reading. */
export const TELEMETRY_RECEIVED = 'telemetry.received';

/** Public API / SSE shapes. Never expose Prisma models directly. */
export interface FarmResponse {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
}

export interface TurbineResponse {
  /** The business key (turbines.turbine_id, e.g. "TURB001"), used in URLs and SSE payloads. */
  id: string;
  farmId: string;
  latitude: number;
  longitude: number;
  /** Whether the turbine has been commissioned. */
  commissioned: boolean;
}

export interface TelemetryResponse {
  id: string;
  turbineId: string;
  farmId: string;
  /** When the turbine measured the values (ISO, UTC). */
  timestamp: string;
  /** When the platform received the reading (ISO, UTC). */
  receivedAt: string;
  powerOutputKw: number;
  windSpeedMs: number;
  rotorRpm: number;
  bladePitchDeg: number;
  gearboxTempC: number;
  /**
   * The alert rules this reading triggered when it was ingested (telemetry_alerts), worst level
   * first, each as the rule is now (joined from alerts_config). Empty when none fired.
   */
  alerts: AlertConfigResponse[];
}

/** Prisma `include` that loads what `toTelemetryResponse` needs: the triggered rules. */
export const TELEMETRY_ALERTS_INCLUDE = {
  alerts: { include: { alert: true } },
} as const satisfies Prisma.TelemetryInclude;

/** A reading with its triggered rules (`include: TELEMETRY_ALERTS_INCLUDE`, or built by ingestion). */
export type TelemetryWithAlerts = Telemetry & {
  alerts: readonly { alert: AlertConfig }[];
};

/** The measured values of a reading, in a fixed order (API field names). */
export const TELEMETRY_METRICS = [
  'powerOutputKw',
  'windSpeedMs',
  'rotorRpm',
  'bladePitchDeg',
  'gearboxTempC',
] as const;
export type TelemetryMetric = (typeof TELEMETRY_METRICS)[number];

/** Median, highest and lowest value of one metric over a set of readings. */
export interface MetricStats {
  median: number;
  high: number;
  low: number;
}

/**
 * GET /api/turbines/:id/telemetry/stats: statistics over exactly the readings that
 * GET /api/turbines/:id/telemetry returns for the same query (from/to/limit).
 */
export interface TelemetryStatsResponse {
  turbineId: string;
  /** Measurement time of the oldest reading covered (ISO, UTC); null when there are none. */
  from: string | null;
  /** Measurement time of the newest reading covered (ISO, UTC, inclusive); null when there are none. */
  to: string | null;
  /** Number of readings covered. */
  count: number;
  /** Per metric; null when there are no readings. */
  metrics: Record<TelemetryMetric, MetricStats | null>;
}

/**
 * One aggregate row as returned by the stats query: `<metric>_median|_high|_low` per metric.
 * Values are converted with Number(), so numeric, bigint or string results are safe too.
 */
export interface TelemetryStatsRow {
  count: number | bigint;
  first_timestamp: Date | null;
  last_timestamp: Date | null;
  [column: string]: unknown;
}

/** Snake-case column prefix of each metric (the telemetry table's column names). */
export const TELEMETRY_METRIC_COLUMNS: Record<TelemetryMetric, string> = {
  powerOutputKw: 'power_output_kw',
  windSpeedMs: 'wind_speed_ms',
  rotorRpm: 'rotor_rpm',
  bladePitchDeg: 'blade_pitch_deg',
  gearboxTempC: 'gearbox_temp_c',
};

export function toTelemetryStatsResponse(
  turbineId: string,
  row: TelemetryStatsRow,
): TelemetryStatsResponse {
  const count = Number(row.count);
  const value = (column: string) => Number(row[column]);
  const metrics = Object.fromEntries(
    TELEMETRY_METRICS.map((metric) => {
      const column = TELEMETRY_METRIC_COLUMNS[metric];
      return [
        metric,
        count === 0
          ? null
          : {
              median: value(`${column}_median`),
              high: value(`${column}_high`),
              low: value(`${column}_low`),
            },
      ];
    }),
  ) as Record<TelemetryMetric, MetricStats | null>;
  return {
    turbineId,
    from: count ? (row.first_timestamp?.toISOString() ?? null) : null,
    to: count ? (row.last_timestamp?.toISOString() ?? null) : null,
    count,
    metrics,
  };
}

export function toFarmResponse(farm: Farm): FarmResponse {
  return {
    id: farm.id,
    name: farm.name,
    latitude: farm.latitude.toNumber(),
    longitude: farm.longitude.toNumber(),
  };
}

/**
 * `id` is the business key (turbine_id, e.g. "TURB001"), which telemetry, URLs and SSE events use.
 * The internal UUID primary key (turbines.id) is deliberately not exposed.
 */
export function toTurbineResponse(turbine: Turbine): TurbineResponse {
  return {
    id: turbine.turbineId,
    farmId: turbine.farmId,
    latitude: turbine.latitude.toNumber(),
    longitude: turbine.longitude.toNumber(),
    commissioned: turbine.commissioned,
  };
}

export function toTelemetryResponse(
  reading: TelemetryWithAlerts,
): TelemetryResponse {
  return {
    id: reading.id,
    turbineId: reading.turbineId,
    farmId: reading.farmId,
    timestamp: reading.timestamp.toISOString(),
    receivedAt: reading.receivedAt.toISOString(),
    powerOutputKw: reading.powerOutputKw,
    windSpeedMs: reading.windSpeedMs,
    rotorRpm: reading.rotorRpm,
    bladePitchDeg: reading.bladePitchDeg,
    gearboxTempC: reading.gearboxTempC,
    alerts: reading.alerts
      .map(({ alert }) => alert)
      .sort(compareAlertsWorstFirst)
      .map(toAlertConfigResponse),
  };
}

// ---------------------------------------------------------------------------------------------
// Farm weather (Open-Meteo, farm_weather_hourly)

/** One hour of a farm's weather (GET /api/farms/:farmId/weather?interval=hourly). */
export interface WeatherHourResponse {
  /** Start of the UTC hour (ISO). */
  time: string;
  /** `archive` (final, ERA5) or `forecast` (recent days; replaced once the archive has them). */
  source: WeatherSource;
  windSpeed10mMs: number | null;
  windSpeed100mMs: number | null;
  windDirection10mDeg: number | null;
  windDirection100mDeg: number | null;
  /** Maximum gust in the preceding hour. */
  windGusts10mMs: number | null;
  temperature2mC: number | null;
  relativeHumidity2mPct: number | null;
  surfacePressureHpa: number | null;
  /** Sum over the preceding hour. */
  precipitationMm: number | null;
  cloudCoverPct: number | null;
}

/** One UTC day of a farm's weather, aggregated from its hours (interval=daily). */
export interface WeatherDayResponse {
  /** The UTC day (YYYY-MM-DD). */
  date: string;
  /** Hours stored for the day within the range (24 for a complete day). */
  hours: number;
  /** `forecast` if any hour of the day is a forecast hour, else `archive`. */
  source: WeatherSource;
  windSpeed10mMeanMs: number | null;
  windSpeed10mMaxMs: number | null;
  windSpeed100mMeanMs: number | null;
  windSpeed100mMaxMs: number | null;
  windGusts10mMaxMs: number | null;
  /** Dominant 100 m wind direction: the vector mean of the hourly directions, 0–360. */
  windDirection100mDeg: number | null;
  temperature2mMinC: number | null;
  temperature2mMaxC: number | null;
  temperature2mMeanC: number | null;
  relativeHumidity2mMeanPct: number | null;
  surfacePressureMeanHpa: number | null;
  precipitationSumMm: number | null;
  cloudCoverMeanPct: number | null;
}

export type WeatherInterval = 'hourly' | 'daily';

/** GET /api/farms/:farmId/weather. */
export type FarmWeatherResponse = {
  farmId: string;
  /** The requested [from, to) range (ISO). */
  from: string;
  to: string;
} & (
  | { interval: 'hourly'; points: WeatherHourResponse[] }
  | { interval: 'daily'; points: WeatherDayResponse[] }
);

export function toWeatherHourResponse(
  row: FarmWeatherHourly,
): WeatherHourResponse {
  return {
    time: row.time.toISOString(),
    source: row.source,
    windSpeed10mMs: row.windSpeed10mMs,
    windSpeed100mMs: row.windSpeed100mMs,
    windDirection10mDeg: row.windDirection10mDeg,
    windDirection100mDeg: row.windDirection100mDeg,
    windGusts10mMs: row.windGusts10mMs,
    temperature2mC: row.temperature2mC,
    relativeHumidity2mPct: row.relativeHumidity2mPct,
    surfacePressureHpa: row.surfacePressureHpa,
    precipitationMm: row.precipitationMm,
    cloudCoverPct: row.cloudCoverPct,
  };
}

/** A row of the daily weather query (snake_case aliases; numbers may arrive as strings). */
export interface WeatherDayRow {
  day: Date;
  hours: number | bigint;
  has_forecast: boolean;
  wind_speed_10m_mean: unknown;
  wind_speed_10m_max: unknown;
  wind_speed_100m_mean: unknown;
  wind_speed_100m_max: unknown;
  wind_gusts_10m_max: unknown;
  wind_direction_100m: unknown;
  temperature_2m_min: unknown;
  temperature_2m_max: unknown;
  temperature_2m_mean: unknown;
  relative_humidity_2m_mean: unknown;
  surface_pressure_mean: unknown;
  precipitation_sum: unknown;
  cloud_cover_mean: unknown;
}

/** Rounded to 2 decimals (means of doubles carry float noise); null stays null. */
const round2 = (value: unknown): number | null =>
  value === null || value === undefined
    ? null
    : Math.round(Number(value) * 100) / 100;

export function toWeatherDayResponse(row: WeatherDayRow): WeatherDayResponse {
  const direction = round2(row.wind_direction_100m);
  return {
    date: row.day.toISOString().slice(0, 10),
    hours: Number(row.hours),
    source: row.has_forecast ? 'forecast' : 'archive',
    windSpeed10mMeanMs: round2(row.wind_speed_10m_mean),
    windSpeed10mMaxMs: round2(row.wind_speed_10m_max),
    windSpeed100mMeanMs: round2(row.wind_speed_100m_mean),
    windSpeed100mMaxMs: round2(row.wind_speed_100m_max),
    windGusts10mMaxMs: round2(row.wind_gusts_10m_max),
    // 359.999 rounds to 360, which is north: report it as 0.
    windDirection100mDeg: direction === null ? null : direction % 360,
    temperature2mMinC: round2(row.temperature_2m_min),
    temperature2mMaxC: round2(row.temperature_2m_max),
    temperature2mMeanC: round2(row.temperature_2m_mean),
    relativeHumidity2mMeanPct: round2(row.relative_humidity_2m_mean),
    surfacePressureMeanHpa: round2(row.surface_pressure_mean),
    precipitationSumMm: round2(row.precipitation_sum),
    cloudCoverMeanPct: round2(row.cloud_cover_mean),
  };
}
