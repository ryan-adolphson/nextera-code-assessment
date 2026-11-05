import type { AlertConfig } from '../alerting/alert-config.model';
import { hoursToMilliseconds, minutesToMilliseconds } from 'date-fns';
import { millisecondsInMinute } from 'date-fns/constants';

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

/** Mirrors TurbineResponse (PATCH /api/turbines/:id): a turbine without its latest reading. */
export interface TurbineResponse {
  /** The turbine's business key ("TURB001"); the API never exposes its internal UUID. */
  id: string;
  farmId: string;
  latitude: number;
  longitude: number;
  /** Whether the turbine has been commissioned (handed over to operations). */
  commissioned: boolean;
}

/** One row of GET /api/turbines (and GET /api/turbines/:id): a turbine, its farm's name, its latest reading. */
export interface TurbineItem extends TurbineResponse {
  farmName: string;
  latest: Telemetry | null;
}

/** The server's three reporting states (the client keeps the finer `Staleness` per row). */
export type TurbineStatus = 'reporting' | 'stale' | 'no_data';

/** The columns the server can sort turbines by; the metrics need a single-farm scope. */
export type TurbineSortKey = 'id' | 'farm' | 'commissioned' | 'time' | 'power' | 'wind' | 'gearbox';
export const METRIC_SORT_KEYS: readonly TurbineSortKey[] = ['power', 'wind', 'gearbox'];

/** Query of GET /api/turbines. */
export interface TurbineQuery {
  farmId?: string;
  /** Matches turbine id, farm id or farm name. */
  q?: string;
  status?: TurbineStatus;
  /** UTC ISO instant the status filter is judged at (the client clock); sent only with `status`. */
  asOf?: string;
  commissioned?: boolean;
  /** true = only turbines that have reported. */
  hasData?: boolean;
  sort?: TurbineSortKey;
  dir?: 'asc' | 'desc';
  /** At most 100. */
  limit?: number;
  cursor?: string | null;
}

/** GET /api/turbines: one page (keyset paging). `total` is counted up to 10,001. */
export interface TurbinePageResponse {
  items: TurbineItem[];
  nextCursor: string | null;
  prevCursor: string | null;
  total: number;
  totalCapped: boolean;
}

/** GET /api/fleet/summary (refreshed about once a minute). */
export interface FleetSummaryResponse {
  farms: number;
  turbines: number;
  commissioned: number;
  reporting: number;
  stale: number;
  alerting: number;
  powerOutputKw: number;
  asOf: string | null;
}

/** One entry of GET /api/farm-summaries: a farm with its totals and no turbines. */
export interface FarmSummaryResponse {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  turbineCount: number;
  commissioned: number;
  reporting: number;
  stale: number;
  alerting: number;
  powerOutputKw: number;
  windSpeedMs: number | null;
  asOf: string | null;
}

/** One entry of GET /api/farms/:farmId/turbine-markers (at most 2,000). */
export interface TurbineMarkerResponse {
  id: string;
  latitude: number;
  longitude: number;
  status: TurbineStatus;
  timestamp: string | null;
}

/** Fleet-wide, low-volume event: the summaries were rebuilt (`{ asOf }`). */
export const FLEET_TICK = 'fleet.tick';

/** Fleet-wide event: a farm rollup run committed (`{ asOf }`, every 15 min); the History tab reloads. */
export const FARM_ROLLUP_COMPLETED = 'farm-rollup.completed';

/** SSE event published by the ingestion worker for every stored reading. */
export const TELEMETRY_EVENTS = ['telemetry.received'] as const;

/** A reading that arrived this much after it was measured is flagged as delayed. */
export const DELAYED_AFTER_MS = minutesToMilliseconds(10);

/**
 * How far ahead of the client clock a live reading may be dated; later ones are ignored. Wider
 * than ingestion's 5 min (`MAX_FUTURE_SKEW_MS`) because browser clocks drift.
 */
export const LIVE_FUTURE_TOLERANCE_MS = minutesToMilliseconds(10);

/** Turbines report every 5 minutes. */
export const READING_INTERVAL_MS = minutesToMilliseconds(5);

/**
 * The fleet store re-reads the client clock this often (aligned to the minute), for as long as the
 * fleet pages are open. It moves turbines through the staleness levels (`staleness.ts`) and slides
 * the turbine page's window: every minute keeps the right edge at most a minute behind, and
 * readings (on 5-minute boundaries, which are minute boundaries) leave the window on time.
 */
export const CLOCK_TICK_MS = millisecondsInMinute;

/** Time ranges offered on the turbine page; the API caps a request at 7 days (2016 readings). */
export const HISTORY_RANGES = [
  { label: '6h', long: '6 hours', ms: hoursToMilliseconds(6) },
  { label: '24h', long: '24 hours', ms: hoursToMilliseconds(24) },
  { label: '48h', long: '48 hours', ms: hoursToMilliseconds(48) },
  { label: '7d', long: '7 days', ms: hoursToMilliseconds(168) },
] as const;

export const DEFAULT_HISTORY_RANGE_MS = hoursToMilliseconds(24);
export const MAX_HISTORY_READINGS = 2016;
