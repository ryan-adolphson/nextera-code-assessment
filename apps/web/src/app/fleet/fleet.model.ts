import type { AlertConfig } from '../alerting/alert-config.model';

/** Mirrors TelemetryResponse in packages/shared (API + SSE payload). */
export interface Telemetry {
  id: string;
  turbineId: string;
  farmId: string;
  /** Measurement time (ISO, UTC). */
  timestamp: string;
  /** Arrival time (ISO, UTC); later than `timestamp` for delayed readings. */
  receivedAt: string;
  powerOutputKw: number;
  windSpeedMs: number;
  rotorRpm: number;
  bladePitchDeg: number;
  gearboxTempC: number;
  /**
   * The alert rules this reading triggered when it was ingested (telemetry_alerts), worst level
   * first, each as the rule is now. Empty when none fired or the reading predates them.
   */
  alerts: AlertConfig[];
}

/** The measured values of a reading (mirrors TelemetryMetric in packages/shared). */
export type TelemetryMetric =
  'powerOutputKw' | 'windSpeedMs' | 'rotorRpm' | 'bladePitchDeg' | 'gearboxTempC';

/** Median, highest and lowest value of one metric (mirrors MetricStats in packages/shared). */
export interface MetricStats {
  median: number;
  high: number;
  low: number;
}

/**
 * Mirrors TelemetryStatsResponse from GET /api/turbines/:id/telemetry/stats: statistics over the
 * same readings the telemetry endpoint returns for the same from/to/limit.
 */
export interface TelemetryStats {
  turbineId: string;
  /** Oldest and newest measurement time covered (ISO, UTC); null when there are no readings. */
  from: string | null;
  to: string | null;
  count: number;
  /** Null per metric when there are no readings. */
  metrics: Record<TelemetryMetric, MetricStats | null>;
}

/** Mirrors FarmOverview / TurbineOverview from GET /api/farms. */
export interface TurbineOverview {
  /** The turbine's business key ("TURB001"); the API never exposes its internal UUID. */
  id: string;
  farmId: string;
  latitude: number;
  longitude: number;
  /** Whether the turbine has been commissioned (handed over to operations). */
  commissioned: boolean;
  latest: Telemetry | null;
}

export interface FarmOverview {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  turbines: TurbineOverview[];
}

/** SSE event published by the ingestion worker for every stored reading. */
export const TELEMETRY_EVENTS = ['telemetry.received'] as const;

/** A reading that arrived this much after it was measured is flagged as delayed. */
export const DELAYED_AFTER_MS = 10 * 60_000;

/** Turbines report every 5 minutes. */
export const READING_INTERVAL_MS = 5 * 60_000;
const HOUR_MS = 60 * 60_000;

/**
 * The fleet store re-reads the client clock this often (aligned to the minute), for as long as the
 * fleet pages are open. It moves turbines through the staleness levels (`staleness.ts`) and slides
 * the turbine page's window: every minute keeps the right edge at most a minute behind, and
 * readings (on 5-minute boundaries, which are minute boundaries) leave the window on time.
 */
export const CLOCK_TICK_MS = 60_000;

/** Time ranges offered on the turbine page; the API caps a request at 7 days (2016 readings). */
export const HISTORY_RANGES = [
  { label: '6h', long: '6 hours', ms: 6 * HOUR_MS },
  { label: '24h', long: '24 hours', ms: 24 * HOUR_MS },
  { label: '48h', long: '48 hours', ms: 48 * HOUR_MS },
  { label: '7d', long: '7 days', ms: 7 * 24 * HOUR_MS },
] as const;

export const DEFAULT_HISTORY_RANGE_MS = 24 * HOUR_MS;
export const MAX_HISTORY_READINGS = 2016;
