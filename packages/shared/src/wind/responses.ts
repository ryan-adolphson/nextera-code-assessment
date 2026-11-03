import type {
  AlertConfig,
  Farm,
  FarmWeather,
  Prisma,
  Telemetry,
  Turbine,
} from '../generated/prisma/client.js';
import {
  toAlertConfigResponse,
  type AlertConfigResponse,
} from './alert-config.js';
import { compareAlertsWorstFirst } from './evaluate-alerts.js';
import { FARM_ROLLUP_METRICS } from './farm-rollup.js';

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
// Farm weather (Open-Meteo forecast models, 30-minute farm_weather)

/** 30 minutes of a farm's weather (GET /api/farms/:farmId/weather?interval=30min). */
export interface WeatherHalfHourResponse {
  /** Start of the 30-minute UTC bucket (ISO; :00 or :30). */
  time: string;
  /** 15-minute values the bucket was aggregated from (1 or 2). */
  samples: number;
  /** Means of the 15-minute values (gusts: max, precipitation: sum, directions: vector mean). */
  windSpeed10mMs: number | null;
  /** 80 m: the Open-Meteo level closest to hub height. */
  windSpeed80mMs: number | null;
  windDirection10mDeg: number | null;
  windDirection80mDeg: number | null;
  windGusts10mMs: number | null;
  temperature2mC: number | null;
  relativeHumidity2mPct: number | null;
  surfacePressureHpa: number | null;
  precipitationMm: number | null;
  cloudCoverPct: number | null;
}

/** One day of a farm's weather in the query's time zone, aggregated from its 30-minute buckets (interval=daily). */
export interface WeatherDayResponse {
  /** The local calendar day in the query's `timeZone` (YYYY-MM-DD; UTC by default). */
  date: string;
  /**
   * 30-minute buckets stored for the day within the range: 48 for a complete day, 46 or 50 for a
   * complete local day with a DST change.
   */
  samples: number;
  windSpeed10mMeanMs: number | null;
  windSpeed10mMaxMs: number | null;
  windSpeed80mMeanMs: number | null;
  windSpeed80mMaxMs: number | null;
  /** Dominant 80 m wind direction: the vector mean of the 30-minute directions, 0–360. */
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

export type WeatherInterval = '30min' | 'daily';

/** GET /api/farms/:farmId/weather. */
export type FarmWeatherResponse = {
  farmId: string;
  /** The requested [from, to) range (ISO). */
  from: string;
  to: string;
  /** IANA zone of the daily buckets (default `UTC`); 30-minute `time`s are UTC instants regardless. */
  timeZone: string;
} & (
  | { interval: '30min'; points: WeatherHalfHourResponse[] }
  | { interval: 'daily'; points: WeatherDayResponse[] }
);

/** GET /api/turbines/:id/weather: the weather of the turbine's current farm. */
export type TurbineWeatherResponse = FarmWeatherResponse & {
  /** The turbine's business key ('TURB001'). */
  turbineId: string;
};

export function toWeatherHalfHourResponse(
  row: FarmWeather,
): WeatherHalfHourResponse {
  return {
    time: row.time.toISOString(),
    samples: row.samples,
    windSpeed10mMs: row.windSpeed10mMs,
    windSpeed80mMs: row.windSpeed80mMs,
    windDirection10mDeg: row.windDirection10mDeg,
    windDirection80mDeg: row.windDirection80mDeg,
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
  /** The local calendar day (YYYY-MM-DD), formatted in Postgres. */
  day: string;
  samples: number | bigint;
  wind_speed_10m_mean: unknown;
  wind_speed_10m_max: unknown;
  wind_speed_80m_mean: unknown;
  wind_speed_80m_max: unknown;
  wind_direction_80m: unknown;
  wind_gusts_10m_max: unknown;
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
  const direction = round2(row.wind_direction_80m);
  return {
    date: row.day,
    samples: Number(row.samples),
    windSpeed10mMeanMs: round2(row.wind_speed_10m_mean),
    windSpeed10mMaxMs: round2(row.wind_speed_10m_max),
    windSpeed80mMeanMs: round2(row.wind_speed_80m_mean),
    windSpeed80mMaxMs: round2(row.wind_speed_80m_max),
    // 359.999 rounds to 360, which is north: report it as 0.
    windDirection80mDeg: direction === null ? null : direction % 360,
    windGusts10mMaxMs: round2(row.wind_gusts_10m_max),
    temperature2mMinC: round2(row.temperature_2m_min),
    temperature2mMaxC: round2(row.temperature_2m_max),
    temperature2mMeanC: round2(row.temperature_2m_mean),
    relativeHumidity2mMeanPct: round2(row.relative_humidity_2m_mean),
    surfacePressureMeanHpa: round2(row.surface_pressure_mean),
    precipitationSumMm: round2(row.precipitation_sum),
    cloudCoverMeanPct: round2(row.cloud_cover_mean),
  };
}

// ---------------------------------------------------------------------------------------------
// Farm daily history (GET /api/farms/:farmId/telemetry/daily), from the farm rollups

/** A candle: the first, last, highest and lowest value of a series over a period. */
export interface Ohlc {
  open: number;
  close: number;
  high: number;
  low: number;
}

/**
 * One local day of a farm's series (power summed over the turbines reporting at each timestamp,
 * the other metrics averaged): open = the day's first point, close = its last, high/low over the
 * day. Values rounded to 2 decimals.
 */
export interface FarmDayResponse {
  /** The local calendar day in the response's timeZone (YYYY-MM-DD). */
  date: string;
  /** The most distinct turbines that reported in any 30 minutes of the day. */
  turbines: number;
  /** Readings in the day. */
  readings: number;
  powerOutputKw: Ohlc;
  windSpeedMs: Ohlc;
  rotorRpm: Ohlc;
  bladePitchDeg: Ohlc;
  gearboxTempC: Ohlc;
}

/** GET /api/farms/:farmId/telemetry/daily. */
export interface FarmDailyHistoryResponse {
  farmId: string;
  /** The requested [from, to) (ISO, UTC). */
  from: string;
  to: string;
  /** IANA zone of the days (default UTC). */
  timeZone: string;
  /** Turbines on the farm now. */
  turbineCount: number;
  /** When the rollup job last wrote any of the range's rows (ISO); null when there are none. */
  computedAt: string | null;
  /** Oldest first; days without readings are omitted. */
  days: FarmDayResponse[];
}

/** One row of the daily query: the day, its counts and `<prefix>_open|_close|_high|_low`. */
export interface FarmDayRow {
  day: string;
  turbines: number | bigint;
  readings: number | bigint;
  computed_at: Date;
  [column: string]: unknown;
}

const round = (value: unknown): number => Math.round(Number(value) * 100) / 100;

export function toFarmDayResponse(row: FarmDayRow): FarmDayResponse {
  const ohlc = (metric: TelemetryMetric): Ohlc => {
    const p = FARM_ROLLUP_METRICS[metric].prefix;
    return {
      open: round(row[`${p}_open`]),
      close: round(row[`${p}_close`]),
      high: round(row[`${p}_high`]),
      low: round(row[`${p}_low`]),
    };
  };
  return {
    date: row.day,
    turbines: Number(row.turbines),
    readings: Number(row.readings),
    powerOutputKw: ohlc('powerOutputKw'),
    windSpeedMs: ohlc('windSpeedMs'),
    rotorRpm: ohlc('rotorRpm'),
    bladePitchDeg: ohlc('bladePitchDeg'),
    gearboxTempC: ohlc('gearboxTempC'),
  };
}
