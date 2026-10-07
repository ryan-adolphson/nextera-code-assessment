import type {
  AlertConfig,
  Farm,
  Prisma,
  Telemetry,
  Turbine,
} from '../generated/prisma/client.js';
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
