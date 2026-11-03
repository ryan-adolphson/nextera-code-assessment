import { Prisma } from '../generated/prisma/client.js';
import type { HeldTelemetry, Telemetry } from '../generated/prisma/client.js';
import type {
  AlertLevel,
  UnallocatedStatus,
} from '../generated/prisma/enums.js';
import {
  ANOMALY_MIN_READINGS,
  ANOMALY_STEP_MINUTES,
  EXPECTED_POWER_MIN_BIN_READINGS,
  LOW_POWER_FALLBACK_KW,
  LOW_POWER_MAX_RATIO,
  LOW_POWER_MIN_WIND_MS,
  STUCK_SENSOR_MIN_POWER_RANGE_KW,
  STUCK_SENSOR_MIN_READINGS,
} from './anomalies.js';
import {
  toAlertConfigResponse,
  type AlertConfigResponse,
} from './alert-config.js';
import {
  TELEMETRY_ALERTS_INCLUDE,
  TELEMETRY_METRIC_COLUMNS,
  TELEMETRY_METRICS,
  toAnomaliesResponse,
  toFarmResponse,
  toTelemetryResponse,
  toTelemetryStatsResponse,
  toTurbineResponse,
  toWeatherDayResponse,
  toWeatherHalfHourResponse,
  toFarmDayResponse,
  type AnomaliesResponse,
  type AnomalyRow,
  type FarmDailyHistoryResponse,
  type FarmDayRow,
  type FarmResponse,
  type FarmWeatherResponse,
  type TurbineWeatherResponse,
  type TelemetryMetric,
  type TelemetryResponse,
  type TelemetryStatsResponse,
  type TelemetryStatsRow,
  type TelemetryWithAlerts,
  type TurbineResponse,
  type WeatherDayRow,
  type WeatherInterval,
} from './responses.js';
import { FARM_ROLLUP_METRICS } from './farm-rollup.js';
import {
  toHeldReadingResponse,
  toUnallocatedResponse,
  type FarmRef,
  type HeldReadingResponse,
  type UnallocatedTurbineResponse,
} from './unallocated.js';

/**
 * The fleet's read queries, shared by the API (behind its HTTP wrappers) and the MCP server. Plain
 * functions over any Prisma client (or a transaction); they return the public response shapes and
 * throw `QueryNotFoundError` / `QueryInputError` (no HTTP types), which each caller maps itself.
 */
export type ReadClient = Prisma.TransactionClient;

/** 288 readings = 24 hours at the 5-minute reporting interval. */
export const DEFAULT_TELEMETRY_LIMIT = 288;
/** 2016 readings = 7 days. */
export const MAX_TELEMETRY_LIMIT = 2016;
/** The widest [from, to) range of the alert and report queries, so one call can't pull the table. */
export const MAX_QUERY_RANGE_DAYS = 31;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Base class of the errors the read queries throw on purpose (never for database failures). */
export class QueryError extends Error {}
/** An unknown farm or turbine (the API answers 404). */
export class QueryNotFoundError extends QueryError {
  override readonly name = 'QueryNotFoundError';
}
/** Arguments that break a data rule, e.g. a reversed or too long range (the API answers 400). */
export class QueryInputError extends QueryError {
  override readonly name = 'QueryInputError';
}

/**
 * Parses a [from, to) range of ISO instants (already validated as timestamps by the caller) and
 * rejects an empty or reversed range, or one longer than `maxDays`.
 */
export function parseRange(
  from: string,
  to: string,
  maxDays: number = MAX_QUERY_RANGE_DAYS,
): { start: Date; end: Date } {
  const start = new Date(from);
  const end = new Date(to);
  if (end <= start) throw new QueryInputError('to must be after from');
  if (end.getTime() - start.getTime() > maxDays * DAY_MS) {
    throw new QueryInputError(`The range may span at most ${maxDays} days`);
  }
  return { start, end };
}

// ---------------------------------------------------------------------------------------------
// Fleet overview: farms → turbines → latest reading

export interface TurbineOverview extends TurbineResponse {
  /** Most recent reading by measurement time (not arrival time); null if none yet. */
  latest: TelemetryResponse | null;
}

export interface FarmOverview extends FarmResponse {
  turbines: TurbineOverview[];
}

/** Raw row shape of the telemetry table (snake_case columns). */
interface TelemetryRow {
  id: string;
  turbine_id: string;
  farm_id: string;
  timestamp: Date;
  received_at: Date;
  created_at: Date;
  power_output_kw: number;
  wind_speed_ms: number;
  rotor_rpm: number;
  blade_pitch_deg: number;
  gearbox_temp_c: number;
}

const fromRow = (r: TelemetryRow): Telemetry => ({
  id: r.id,
  turbineId: r.turbine_id,
  farmId: r.farm_id,
  timestamp: r.timestamp,
  receivedAt: r.received_at,
  createdAt: r.created_at,
  powerOutputKw: r.power_output_kw,
  windSpeedMs: r.wind_speed_ms,
  rotorRpm: r.rotor_rpm,
  bladePitchDeg: r.blade_pitch_deg,
  gearboxTempC: r.gearbox_temp_c,
});

/** Every farm with its turbines and each turbine's latest reading: the fleet overview. */
export async function listFarms(db: ReadClient): Promise<FarmOverview[]> {
  const [farms, latestRows] = await Promise.all([
    db.farm.findMany({
      orderBy: { id: 'asc' },
      include: { turbines: { orderBy: { turbineId: 'asc' } } },
    }),
    // One index lookup per turbine on (turbine_id, timestamp). Prisma's nested `take: 1` would
    // load every reading into memory, which doesn't scale with history size.
    db.$queryRaw<TelemetryRow[]>`
      SELECT latest.*
      FROM turbines t
      CROSS JOIN LATERAL (
        SELECT * FROM telemetry r
        WHERE r.turbine_id = t.turbine_id
        ORDER BY r.timestamp DESC
        LIMIT 1
      ) latest`,
  ]);

  const latest = await withAlerts(db, latestRows.map(fromRow));
  const latestByTurbine = new Map(
    latest.map((reading) => [reading.turbineId, toTelemetryResponse(reading)]),
  );
  return farms.map((farm) => ({
    ...toFarmResponse(farm),
    turbines: farm.turbines.map((turbine) => ({
      ...toTurbineResponse(turbine),
      latest: latestByTurbine.get(turbine.turbineId) ?? null,
    })),
  }));
}

/**
 * Adds each reading's triggered rules (telemetry_alerts joined with alerts_config) to readings
 * loaded with raw SQL: one query for all of them.
 */
async function withAlerts(
  db: ReadClient,
  readings: Telemetry[],
): Promise<TelemetryWithAlerts[]> {
  if (!readings.length) return [];
  const links = await db.telemetryAlert.findMany({
    where: { telemetryId: { in: readings.map((r) => r.id) } },
    include: { alert: true },
  });
  const byReading = new Map<string, typeof links>();
  for (const link of links) {
    byReading.set(link.telemetryId, [
      ...(byReading.get(link.telemetryId) ?? []),
      link,
    ]);
  }
  return readings.map((reading) => ({
    ...reading,
    alerts: byReading.get(reading.id) ?? [],
  }));
}

// ---------------------------------------------------------------------------------------------
// One turbine

export interface TurbineDetail extends TurbineOverview {
  farm: FarmResponse;
}

/** A turbine (by business key) with its farm and its latest reading by measurement time. */
export async function getTurbine(
  db: ReadClient,
  turbineId: string,
): Promise<TurbineDetail> {
  const turbine = await db.turbine.findUnique({
    where: { turbineId },
    include: { farm: true },
  });
  if (!turbine) throw turbineNotFound(turbineId);
  const latest = await db.telemetry.findFirst({
    where: { turbineId },
    orderBy: { timestamp: 'desc' },
    include: TELEMETRY_ALERTS_INCLUDE,
  });
  return {
    ...toTurbineResponse(turbine),
    farm: toFarmResponse(turbine.farm),
    latest: latest ? toTelemetryResponse(latest) : null,
  };
}

/** A telemetry window: [from, to) on measurement time (both optional), the newest `limit`. */
export interface TelemetryWindow {
  /** Inclusive lower bound (ISO instant). */
  from?: string;
  /** Exclusive upper bound (ISO instant). */
  to?: string;
  limit: number;
}

/** A turbine's readings, newest first, within an optional time range. */
export async function turbineTelemetry(
  db: ReadClient,
  turbineId: string,
  window: TelemetryWindow,
): Promise<TelemetryResponse[]> {
  await assertTurbineExists(db, turbineId);

  const readings = await db.telemetry.findMany({
    where: {
      turbineId,
      timestamp: {
        ...(window.from && { gte: new Date(window.from) }),
        ...(window.to && { lt: new Date(window.to) }),
      },
    },
    orderBy: { timestamp: 'desc' },
    take: window.limit,
    include: TELEMETRY_ALERTS_INCLUDE, // the triggered rules, joined from alerts_config
  });
  return readings.map(toTelemetryResponse);
}

/**
 * Per metric: `<column>_median`, `<column>_high`, `<column>_low`. The column names are fixed
 * constants (never user input), so Prisma.raw is safe here. All values are double precision,
 * so they arrive as JS numbers.
 */
const METRIC_AGGREGATES = Prisma.raw(
  TELEMETRY_METRICS.map((metric) => {
    const c = TELEMETRY_METRIC_COLUMNS[metric];
    return [
      `percentile_cont(0.5) WITHIN GROUP (ORDER BY w.${c}) AS ${c}_median`,
      `max(w.${c}) AS ${c}_high`,
      `min(w.${c}) AS ${c}_low`,
    ].join(',\n  ');
  }).join(',\n  '),
);

/**
 * Median, high and low of every metric over exactly the readings `turbineTelemetry()` returns for
 * the same window: [from, to) on measurement time, the newest `limit`. One aggregate query.
 */
export async function telemetryStats(
  db: ReadClient,
  turbineId: string,
  window: TelemetryWindow,
): Promise<TelemetryStatsResponse> {
  await assertTurbineExists(db, turbineId);

  const from = window.from
    ? Prisma.sql`AND r.timestamp >= ${new Date(window.from)}`
    : Prisma.empty;
  const to = window.to
    ? Prisma.sql`AND r.timestamp < ${new Date(window.to)}`
    : Prisma.empty;
  // Aggregates without GROUP BY always return one row (count 0 and nulls for an empty window).
  const [row] = await db.$queryRaw<TelemetryStatsRow[]>`
    SELECT
      count(*)::int AS count,
      min(w.timestamp) AS first_timestamp,
      max(w.timestamp) AS last_timestamp,
      ${METRIC_AGGREGATES}
    FROM (
      SELECT * FROM telemetry r
      WHERE r.turbine_id = ${turbineId} ${from} ${to}
      ORDER BY r.timestamp DESC
      LIMIT ${window.limit}
    ) w`;
  return toTelemetryStatsResponse(turbineId, row);
}

async function assertTurbineExists(
  db: ReadClient,
  turbineId: string,
): Promise<void> {
  const turbine = await db.turbine.findUnique({
    where: { turbineId },
    select: { turbineId: true },
  });
  if (!turbine) throw turbineNotFound(turbineId);
}

const turbineNotFound = (turbineId: string) =>
  new QueryNotFoundError(`Turbine ${turbineId} not found`);

// ---------------------------------------------------------------------------------------------
// Alerts

/** A required [from, to) range on measurement time (ISO instants), at most 31 days. */
export interface TimeRange {
  from: string;
  to: string;
}

/**
 * Every reading measured in [from, to) that triggered at least one rule, with those rules
 * (joined from alerts_config, worst level first), grouped by turbine (turbine id ascending) and
 * newest first within a turbine. Disabled rules still show on the readings they flagged.
 */
export async function alertsInRange(
  db: ReadClient,
  { from, to }: TimeRange,
): Promise<TelemetryResponse[]> {
  const { start, end } = parseRange(from, to);

  const readings = await db.telemetry.findMany({
    where: {
      timestamp: { gte: start, lt: end },
      alerts: { some: {} },
    },
    orderBy: [{ turbineId: 'asc' }, { timestamp: 'desc' }],
    include: TELEMETRY_ALERTS_INCLUDE,
  });
  return readings.map(toTelemetryResponse);
}

// ---------------------------------------------------------------------------------------------
// Anomalies

/** The columns `listAnomalies` can find a stuck sensor on: label, value column, run-id column. */
const STUCK_METRICS = [
  { metric: 'gearboxTempC', value: 'g', run: 'g_run' },
  { metric: 'windSpeedMs', value: 'w', run: 'w_run' },
  { metric: 'rotorRpm', value: 'rpm', run: 'rpm_run' },
] as const;

/**
 * The stuck-sensor episodes of one metric, from the `marked` CTE: the readings of its long runs
 * (`long_runs`), grouped, whose power range shows the turbine kept moving. Identifiers come from
 * the constant above, never from input.
 */
const stuckEpisodes = (
  metric: string,
  value: string,
  run: string,
) => Prisma.sql`
      SELECT 'stuck_sensor'::text AS kind, ${metric}::text AS metric,
             m.turbine_id, max(m.farm_id) AS farm_id,
             min(m.timestamp) AS episode_start, max(m.timestamp) AS episode_end,
             count(*)::int AS readings,
             min(m.${Prisma.raw(value)})::float8 AS value,
             NULL::float8 AS wind_speed_ms,
             NULL::float8 AS lost_kwh
      FROM marked m
      JOIN long_runs lr
        ON lr.metric = ${metric} AND lr.turbine_id = m.turbine_id AND lr.run = m.${Prisma.raw(run)}
      GROUP BY m.turbine_id, m.${Prisma.raw(run)}
      HAVING count(*) >= ${STUCK_SENSOR_MIN_READINGS}::int
         AND max(m.p) - min(m.p) >= ${STUCK_SENSOR_MIN_POWER_RANGE_KW}::float8`;

/**
 * Anomaly episodes in [from, to) on measurement time, computed on read in one SQL statement over
 * the telemetry table (no stored state):
 *
 * - `low_power_in_wind`: readings with wind >= 10 m/s and power < 0.1 x the expected power, in
 *   runs of >= 3 consecutive readings of one turbine. Expected power is the median power of all
 *   fleet readings in the same 1 m/s wind bin within the queried range (a fleet-derived
 *   estimate, not a manufacturer power curve). A bin with fewer than 20 readings falls back to
 *   the nearest bin below it that has 20; with none, the ratio can't be judged, so power < 100 kW
 *   counts as low and the reading adds nothing to the lost-output estimate (null if no reading
 *   of the episode has one). Lost output = sum of max(0, expected - actual) x 5/60 kWh.
 * - `stuck_sensor`: the same gearbox temperature, wind speed or rotor rpm in >= 12 consecutive
 *   readings (1 hour) while the turbine's power range over them is >= 50 kW: a sensor stuck on a
 *   turbine that keeps moving. Flat power too means a plateau (calm-wind clamp, rated output) or a
 *   turbine that is off, not a faulty sensor. Not power itself, which legitimately sits at 0 or
 *   at rated output.
 *
 * "Consecutive" means no gap in that turbine's readings (gaps and islands with window functions):
 * two readings more than 5 minutes apart, or a reading that doesn't qualify in between, end an
 * episode. A turbine that stopped reporting is not an anomaly here: the staleness pills cover it.
 * Newest episode end first. Reads the (turbine_id, timestamp) range once per CTE; no index needed.
 */
export async function listAnomalies(
  db: ReadClient,
  { from, to }: TimeRange,
): Promise<AnomaliesResponse> {
  const { start, end } = parseRange(from, to);
  const step = ANOMALY_STEP_MINUTES;

  const rows = await db.$queryRaw<AnomalyRow[]>`
    WITH r AS NOT MATERIALIZED (
      SELECT turbine_id, farm_id, timestamp,
             power_output_kw AS p, wind_speed_ms AS w, rotor_rpm AS rpm, gearbox_temp_c AS g,
             floor(wind_speed_ms)::int AS bin
      FROM telemetry
      WHERE timestamp >= ${start} AND timestamp < ${end}
    ),
    -- MATERIALIZED: else the planner inlines it and re-aggregates the table for every reading.
    bins AS MATERIALIZED (
      SELECT bin, percentile_cont(0.5) WITHIN GROUP (ORDER BY p) AS expected
      FROM r
      GROUP BY bin
      HAVING count(*) >= ${EXPECTED_POWER_MIN_BIN_READINGS}::int
    ),
    judged AS (
      SELECT r.*, e.expected,
             (r.w >= ${LOW_POWER_MIN_WIND_MS}::float8
              AND r.p < CASE WHEN e.expected IS NULL THEN ${LOW_POWER_FALLBACK_KW}::float8
                             ELSE ${LOW_POWER_MAX_RATIO}::float8 * e.expected END) AS low
      FROM r
      LEFT JOIN LATERAL (
        SELECT bins.expected FROM bins
        WHERE r.w >= ${LOW_POWER_MIN_WIND_MS}::float8 AND bins.bin <= r.bin
        ORDER BY bins.bin DESC LIMIT 1
      ) e ON true
    ),
    -- One pass per turbine (a single sort): the previous reading's values, then a run id per
    -- rule that increments whenever the run breaks (gap, or the condition doesn't hold again).
    prev AS (
      SELECT *,
             timestamp - lag(timestamp) OVER t <= make_interval(mins => ${step}::int) AS contiguous,
             lag(low) OVER t AS prev_low,
             lag(g) OVER t AS prev_g,
             lag(w) OVER t AS prev_w,
             lag(rpm) OVER t AS prev_rpm
      FROM judged
      WINDOW t AS (PARTITION BY turbine_id ORDER BY timestamp)
    ),
    marked AS MATERIALIZED (
      SELECT *,
             sum(CASE WHEN low AND prev_low AND contiguous THEN 0 ELSE 1 END) OVER t AS low_run,
             sum(CASE WHEN g = prev_g AND contiguous THEN 0 ELSE 1 END) OVER t AS g_run,
             sum(CASE WHEN w = prev_w AND contiguous THEN 0 ELSE 1 END) OVER t AS w_run,
             sum(CASE WHEN rpm = prev_rpm AND contiguous THEN 0 ELSE 1 END) OVER t AS rpm_run
      FROM prev
      WINDOW t AS (PARTITION BY turbine_id ORDER BY timestamp)
    ),
    low_episodes AS (
      SELECT 'low_power_in_wind'::text AS kind, NULL::text AS metric,
             turbine_id, max(farm_id) AS farm_id,
             min(timestamp) AS episode_start, max(timestamp) AS episode_end,
             count(*)::int AS readings,
             NULL::float8 AS value,
             round(avg(w)::numeric, 2)::float8 AS wind_speed_ms,
             round((sum(CASE WHEN expected IS NOT NULL THEN greatest(0, expected - p) END)
                    * ${step}::float8 / 60)::numeric, 1)::float8 AS lost_kwh
      FROM marked
      WHERE low
      GROUP BY turbine_id, low_run
      HAVING count(*) >= ${ANOMALY_MIN_READINGS}::int
    ),
    -- A run of >= N equal values: its run id equals the id N-1 readings earlier. Finding those
    -- (turbine, metric, run) keys first means only their readings are grouped below, instead of
    -- a group per reading (~1M hash groups spilling to disk on a week of a 200-turbine fleet).
    long_runs AS (
      SELECT DISTINCT x.turbine_id, m.metric, m.run
      FROM (
        SELECT turbine_id,
               g_run, lag(g_run, ${STUCK_SENSOR_MIN_READINGS - 1}::int) OVER t AS g_back,
               w_run, lag(w_run, ${STUCK_SENSOR_MIN_READINGS - 1}::int) OVER t AS w_back,
               rpm_run, lag(rpm_run, ${STUCK_SENSOR_MIN_READINGS - 1}::int) OVER t AS rpm_back
        FROM marked
        WINDOW t AS (PARTITION BY turbine_id ORDER BY timestamp)
      ) x
      CROSS JOIN LATERAL (VALUES
        ('gearboxTempC', x.g_run, x.g_back),
        ('windSpeedMs', x.w_run, x.w_back),
        ('rotorRpm', x.rpm_run, x.rpm_back)
      ) AS m(metric, run, back)
      WHERE m.run = m.back
    ),
    stuck_episodes AS (
      ${Prisma.join(
        STUCK_METRICS.map(({ metric, value, run }) =>
          stuckEpisodes(metric, value, run),
        ),
        ' UNION ALL ',
      )}
    )
    SELECT * FROM low_episodes
    UNION ALL
    SELECT * FROM stuck_episodes
    ORDER BY episode_end DESC, turbine_id, kind, metric`;
  return toAnomaliesResponse(start, end, rows);
}

/**
 * Rule list order: metric (telemetry column order), then level severity (info, warn, error), then
 * the threshold value. Postgres sorts enums by declaration order, which is exactly that.
 */
export const ALERT_RULE_ORDER: Prisma.AlertConfigOrderByWithRelationInput[] = [
  { measurementMetric: 'asc' },
  { alertLevel: 'asc' },
  { valueMetric: 'asc' },
  { comparison: 'asc' },
  { id: 'asc' },
];

/** The alert thresholds (alerts_config), all of them by default, in `ALERT_RULE_ORDER`. */
export async function listAlertRules(
  db: ReadClient,
  { includeDisabled = true }: { includeDisabled?: boolean } = {},
): Promise<AlertConfigResponse[]> {
  const rows = await db.alertConfig.findMany({
    ...(!includeDisabled && { where: { enabled: true } }),
    orderBy: ALERT_RULE_ORDER,
  });
  return rows.map(toAlertConfigResponse);
}

// ---------------------------------------------------------------------------------------------
// Reports

/** What a report is about: a whole farm or one turbine (business keys, as in every response). */
export interface ReportScope {
  kind: 'farm' | 'turbine';
  /** The farm id ("FARM01") or the turbine id ("TURB001"). */
  id: string;
  /** The farm's name ("Prairie Ridge"); for a turbine, its farm's name. */
  name: string;
  farmId: string;
}

/** A report's subject (exactly one of farmId and turbineId) and its [from, to) range. */
export interface ReportQuery extends TimeRange {
  farmId?: string;
  turbineId?: string;
}

/** GET /api/reports/telemetry. */
export interface TelemetryReport {
  scope: ReportScope;
  from: string;
  to: string;
  /** Every reading measured in [from, to), with its triggered rules; by turbine, then time. */
  readings: TelemetryResponse[];
}

/** All readings of a farm or a turbine measured in [from, to), with their triggered rules. */
export async function reportTelemetry(
  db: ReadClient,
  query: ReportQuery,
): Promise<TelemetryReport> {
  const scope = await reportScope(db, query);
  const { start, end } = parseRange(query.from, query.to);

  const readings = await db.telemetry.findMany({
    where: { ...scopeWhere(scope), timestamp: { gte: start, lt: end } },
    orderBy: [{ turbineId: 'asc' }, { timestamp: 'asc' }],
    include: TELEMETRY_ALERTS_INCLUDE,
  });
  return {
    scope,
    from: start.toISOString(),
    to: end.toISOString(),
    readings: readings.map(toTelemetryResponse),
  };
}

/** Minimum, average and maximum of one metric over a report's readings. */
export interface MetricSummary {
  low: number;
  avg: number;
  high: number;
}

/** A report summarised in Postgres: aggregates instead of every reading. */
export interface TelemetryReportSummary {
  scope: ReportScope;
  from: string;
  to: string;
  /** Number of readings measured in [from, to). */
  count: number;
  /** Measurement time of the oldest and newest reading covered; null when there are none. */
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  /** Per metric; null when there are no readings. */
  metrics: Record<TelemetryMetric, MetricSummary | null>;
  /** Readings that triggered at least one rule. */
  flaggedReadings: number;
  /** Per level: how many rule triggers (a reading can trigger several) and on how many readings. */
  alertsByLevel: Record<AlertLevel, { triggers: number; readings: number }>;
}

const SUMMARY_AGGREGATES = Prisma.raw(
  TELEMETRY_METRICS.map((metric) => {
    const c = TELEMETRY_METRIC_COLUMNS[metric];
    return `min(r.${c}) AS ${c}_low, avg(r.${c}) AS ${c}_avg, max(r.${c}) AS ${c}_high`;
  }).join(',\n  '),
);

/**
 * The same readings as `reportTelemetry()`, summarised: count, first/last measurement time,
 * min/avg/max per metric and alert counts by level. Two aggregate queries, no rows in memory.
 */
export async function reportSummary(
  db: ReadClient,
  query: ReportQuery,
): Promise<TelemetryReportSummary> {
  const scope = await reportScope(db, query);
  const { start, end } = parseRange(query.from, query.to);
  const where = Prisma.sql`${
    scope.kind === 'farm'
      ? Prisma.sql`r.farm_id = ${scope.id}`
      : Prisma.sql`r.turbine_id = ${scope.id}`
  } AND r.timestamp >= ${start} AND r.timestamp < ${end}`;

  const [[row], levels] = await Promise.all([
    db.$queryRaw<TelemetryStatsRow[]>`
      SELECT
        count(*)::int AS count,
        min(r.timestamp) AS first_timestamp,
        max(r.timestamp) AS last_timestamp,
        ${SUMMARY_AGGREGATES}
      FROM telemetry r
      WHERE ${where}`,
    // ROLLUP adds the total row (level NULL): readings flagged by any level, counted once.
    db.$queryRaw<
      { level: AlertLevel | null; triggers: number; readings: number }[]
    >`
      SELECT c.alert_level::text AS level,
             count(*)::int AS triggers,
             count(DISTINCT r.id)::int AS readings
      FROM telemetry r
      JOIN telemetry_alerts ta ON ta.telemetry_id = r.id
      JOIN alerts_config c ON c.id = ta.alert_id
      WHERE ${where}
      GROUP BY ROLLUP (c.alert_level)`,
  ]);

  const count = Number(row.count);
  const value = (column: string) => Number(row[column]);
  const metrics = Object.fromEntries(
    TELEMETRY_METRICS.map((metric) => {
      const c = TELEMETRY_METRIC_COLUMNS[metric];
      return [
        metric,
        count === 0
          ? null
          : {
              low: value(`${c}_low`),
              avg: value(`${c}_avg`),
              high: value(`${c}_high`),
            },
      ];
    }),
  ) as Record<TelemetryMetric, MetricSummary | null>;
  const alertsByLevel: TelemetryReportSummary['alertsByLevel'] = {
    error: { triggers: 0, readings: 0 },
    warn: { triggers: 0, readings: 0 },
    info: { triggers: 0, readings: 0 },
  };
  let flaggedReadings = 0;
  for (const level of levels) {
    if (level.level === null) flaggedReadings = Number(level.readings);
    else {
      alertsByLevel[level.level] = {
        triggers: Number(level.triggers),
        readings: Number(level.readings),
      };
    }
  }

  return {
    scope,
    from: start.toISOString(),
    to: end.toISOString(),
    count,
    firstTimestamp: count ? (row.first_timestamp?.toISOString() ?? null) : null,
    lastTimestamp: count ? (row.last_timestamp?.toISOString() ?? null) : null,
    metrics,
    flaggedReadings,
    alertsByLevel,
  };
}

const scopeWhere = (scope: ReportScope) =>
  scope.kind === 'farm' ? { farmId: scope.id } : { turbineId: scope.id };

/** Exactly one of farmId and turbineId, which must exist. */
async function reportScope(
  db: ReadClient,
  { farmId, turbineId }: ReportQuery,
): Promise<ReportScope> {
  if (!farmId === !turbineId) {
    throw new QueryInputError('Provide exactly one of farmId or turbineId');
  }
  if (farmId) {
    const farm = await db.farm.findUnique({
      where: { id: farmId },
      select: { id: true, name: true },
    });
    if (!farm) throw new QueryNotFoundError(`Farm ${farmId} not found`);
    return { kind: 'farm', id: farm.id, name: farm.name, farmId: farm.id };
  }
  const turbine = await db.turbine.findUnique({
    where: { turbineId: turbineId! },
    select: {
      turbineId: true,
      farmId: true,
      farm: { select: { name: true } },
    },
  });
  if (!turbine) throw turbineNotFound(turbineId!);
  return {
    kind: 'turbine',
    id: turbine.turbineId,
    name: turbine.farm.name,
    farmId: turbine.farmId,
  };
}

// ---------------------------------------------------------------------------------------------
// Unallocated turbines (readings ingestion holds for unknown turbines and farm mismatches)

/** Raw row shape of held_telemetry (snake_case columns). */
interface HeldRow {
  id: string;
  unallocated_id: string;
  turbine_id: string;
  farm_id: string;
  timestamp: Date;
  received_at: Date;
  created_at: Date;
  power_output_kw: number;
  wind_speed_ms: number;
  rotor_rpm: number;
  blade_pitch_deg: number;
  gearbox_temp_c: number;
}

const fromHeldRow = (r: HeldRow): HeldTelemetry => ({
  id: r.id,
  unallocatedId: r.unallocated_id,
  turbineId: r.turbine_id,
  farmId: r.farm_id,
  timestamp: r.timestamp,
  receivedAt: r.received_at,
  createdAt: r.created_at,
  powerOutputKw: r.power_output_kw,
  windSpeedMs: r.wind_speed_ms,
  rotorRpm: r.rotor_rpm,
  bladePitchDeg: r.blade_pitch_deg,
  gearboxTempC: r.gearbox_temp_c,
});

/**
 * The pending (default) or blocked unallocated entries, latest activity first, each with its held
 * count, newest held reading, the reported farm (if it exists) and, for a turbine that exists, its
 * current farm. Pending entries are capped (MAX_PENDING_UNALLOCATED); blocked ones only come from
 * owners' actions. `turbineId` narrows the list to that turbine id's entries (one per reported farm).
 */
export async function listUnallocated(
  db: ReadClient,
  {
    status = 'pending',
    turbineId,
  }: { status?: UnallocatedStatus; turbineId?: string } = {},
): Promise<UnallocatedTurbineResponse[]> {
  return describeUnallocated(
    db,
    turbineId === undefined ? { status } : { status, turbineId },
  );
}

/** One unallocated entry (pending or blocked) as `listUnallocated` shows it. */
export async function getUnallocated(
  db: ReadClient,
  id: string,
): Promise<UnallocatedTurbineResponse> {
  const [entry] = await describeUnallocated(db, { id });
  if (!entry) throw unallocatedNotFound(id);
  return entry;
}

const unallocatedNotFound = (id: string) =>
  new QueryNotFoundError(`Unallocated turbine ${id} not found`);

async function describeUnallocated(
  db: ReadClient,
  where: Prisma.UnallocatedTurbineWhereInput,
): Promise<UnallocatedTurbineResponse[]> {
  const entries = await db.unallocatedTurbine.findMany({
    where,
    orderBy: [{ lastSeenAt: 'desc' }, { turbineId: 'asc' }, { id: 'asc' }],
    include: {
      blockedBy: { select: { email: true } },
      _count: { select: { held: true } },
    },
  });
  if (!entries.length) return [];

  const ids = entries.map((e) => e.id);
  const [latestRows, turbines] = await Promise.all([
    // One index lookup per entry on (unallocated_id, timestamp), as for the fleet's latest readings.
    db.$queryRaw<HeldRow[]>`
      SELECT latest.*
      FROM unnest(${ids}::uuid[]) AS e(id)
      CROSS JOIN LATERAL (
        SELECT * FROM held_telemetry h
        WHERE h.unallocated_id = e.id
        ORDER BY h.timestamp DESC
        LIMIT 1
      ) latest`,
    db.turbine.findMany({
      where: {
        turbineId: { in: [...new Set(entries.map((e) => e.turbineId))] },
      },
      select: { turbineId: true, farmId: true },
    }),
  ]);
  const farmOfTurbine = new Map(turbines.map((t) => [t.turbineId, t.farmId]));
  const farms = await db.farm.findMany({
    where: {
      id: {
        in: [
          ...new Set([
            ...entries.map((e) => e.reportedFarmId),
            ...farmOfTurbine.values(),
          ]),
        ],
      },
    },
    select: { id: true, name: true },
  });
  const farmById = new Map<string, FarmRef>(farms.map((f) => [f.id, f]));
  const latestByEntry = new Map(
    latestRows.map((r) => [String(r.unallocated_id), fromHeldRow(r)]),
  );

  return entries.map(({ _count, ...entry }) => {
    const currentFarmId = farmOfTurbine.get(entry.turbineId);
    return toUnallocatedResponse({
      entry,
      heldCount: _count.held,
      latest: latestByEntry.get(entry.id) ?? null,
      reportedFarm: farmById.get(entry.reportedFarmId) ?? null,
      currentFarm: currentFarmId ? (farmById.get(currentFarmId) ?? null) : null,
    });
  });
}

/** An unallocated entry's held readings, newest first (at most `limit`). */
export async function heldReadings(
  db: ReadClient,
  id: string,
  limit: number = DEFAULT_TELEMETRY_LIMIT,
): Promise<HeldReadingResponse[]> {
  const entry = await db.unallocatedTurbine.findUnique({
    where: { id },
    select: { id: true },
  });
  if (!entry) throw unallocatedNotFound(id);
  const rows = await db.heldTelemetry.findMany({
    where: { unallocatedId: id },
    orderBy: { timestamp: 'desc' },
    take: limit,
  });
  return rows.map(toHeldReadingResponse);
}

// ---------------------------------------------------------------------------------------------
// Farm weather (30-minute Open-Meteo rows; daily figures computed here, never stored). A turbine has
// no weather of its own: it uses its current farm's.

/** The time zone of the daily buckets when none is given. */
export const DEFAULT_WEATHER_TIME_ZONE = 'UTC';

/** A farm's (or turbine's) weather over a required [from, to) range (ISO instants, ≤ 31 days). */
export interface FarmWeatherQuery extends TimeRange {
  interval: WeatherInterval;
  /**
   * IANA zone of the daily buckets (local calendar days, 23 or 25 hours across a DST change);
   * default UTC. 30-minute points are UTC instants, so it only echoes there (but is still checked).
   */
  timeZone?: string;
}

/** What a zone name may look like before Postgres is asked: "UTC", "America/Chicago", "Etc/GMT+6". */
const TIME_ZONE_SHAPE = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;
/** Zone names Postgres knows (checked once per process; the zone database doesn't change at runtime). */
const knownTimeZones = new Set<string>([DEFAULT_WEATHER_TIME_ZONE]);

const timeZoneError = () =>
  new QueryInputError(
    'timeZone must be an IANA time zone name, e.g. "America/Chicago" (default "UTC")',
  );

/**
 * Checks a zone name against Postgres' `pg_timezone_names` (exact name), so only IANA names reach
 * `AT TIME ZONE`: Postgres also accepts POSIX specs such as "UTC+6" there, with the sign inverted.
 */
export async function checkTimeZone(
  db: ReadClient,
  timeZone: string,
): Promise<string> {
  if (knownTimeZones.has(timeZone)) return timeZone;
  if (timeZone.length > 64 || !TIME_ZONE_SHAPE.test(timeZone)) {
    throw timeZoneError();
  }
  const [row] = await db.$queryRaw<{ known: boolean }[]>`
    SELECT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = ${timeZone}) AS known`;
  if (!row?.known) throw timeZoneError();
  knownTimeZones.add(timeZone);
  return timeZone;
}

/**
 * A farm's weather in [from, to) on the bucket's start time, oldest first: the stored 30-minute
 * buckets, or one row per local day in `timeZone` (default UTC) aggregated in Postgres
 * (means/maxima, vector-mean 80 m direction, precipitation sum, the number of buckets covered).
 */
export async function farmWeather(
  db: ReadClient,
  farmId: string,
  query: FarmWeatherQuery,
): Promise<FarmWeatherResponse> {
  const farm = await db.farm.findUnique({
    where: { id: farmId },
    select: { id: true },
  });
  if (!farm) throw new QueryNotFoundError(`Farm ${farmId} not found`);
  return weatherOfFarm(db, farmId, query);
}

/**
 * A turbine's weather: its current farm's (`farmWeather`), with the turbine's id. A turbine moved
 * to another farm gets the new farm's weather for the whole range.
 */
export async function turbineWeather(
  db: ReadClient,
  turbineId: string,
  query: FarmWeatherQuery,
): Promise<TurbineWeatherResponse> {
  const turbine = await db.turbine.findUnique({
    where: { turbineId },
    select: { farmId: true },
  });
  if (!turbine) throw turbineNotFound(turbineId);
  // The FK keeps the farm, so no second existence check.
  const { farmId, ...weather } = await weatherOfFarm(db, turbine.farmId, query);
  return { farmId, turbineId, ...weather };
}

/** The weather of a farm known to exist. */
async function weatherOfFarm(
  db: ReadClient,
  farmId: string,
  {
    from,
    to,
    interval,
    timeZone = DEFAULT_WEATHER_TIME_ZONE,
  }: FarmWeatherQuery,
): Promise<FarmWeatherResponse> {
  const { start, end } = parseRange(from, to);
  const zone = await checkTimeZone(db, timeZone);
  const range = { farmId, from: start.toISOString(), to: end.toISOString() };

  if (interval === '30min') {
    const rows = await db.farmWeather.findMany({
      where: { farmId, time: { gte: start, lt: end } },
      orderBy: { time: 'asc' },
    });
    return {
      ...range,
      interval,
      timeZone: zone,
      points: rows.map(toWeatherHalfHourResponse),
    };
  }

  // The local calendar day of each bucket in the bound zone (never interpolated): the same days
  // as date_trunc('day', w.time, zone), so a DST change gives a 46- or 50-bucket day. The session
  // time zone plays no part.
  const rows = await db.$queryRaw<WeatherDayRow[]>`
    SELECT
      to_char(w.time AT TIME ZONE ${zone}::text, 'YYYY-MM-DD') AS day,
      count(*)::int AS samples,
      avg(w.wind_speed_10m_ms) AS wind_speed_10m_mean,
      max(w.wind_speed_10m_ms) AS wind_speed_10m_max,
      avg(w.wind_speed_80m_ms) AS wind_speed_80m_mean,
      max(w.wind_speed_80m_ms) AS wind_speed_80m_max,
      mod(
        degrees(atan2(
          avg(sin(radians(w.wind_direction_80m_deg))),
          avg(cos(radians(w.wind_direction_80m_deg)))
        ))::numeric + 360,
        360
      )::double precision AS wind_direction_80m,
      max(w.wind_gusts_10m_ms) AS wind_gusts_10m_max,
      min(w.temperature_2m_c) AS temperature_2m_min,
      max(w.temperature_2m_c) AS temperature_2m_max,
      avg(w.temperature_2m_c) AS temperature_2m_mean,
      avg(w.relative_humidity_2m_pct) AS relative_humidity_2m_mean,
      avg(w.surface_pressure_hpa) AS surface_pressure_mean,
      sum(w.precipitation_mm) AS precipitation_sum,
      avg(w.cloud_cover_pct) AS cloud_cover_mean
    FROM farm_weather w
    WHERE w.farm_id = ${farmId} AND w.time >= ${start} AND w.time < ${end}
    GROUP BY 1
    ORDER BY 1`;
  return {
    ...range,
    interval,
    timeZone: zone,
    points: rows.map(toWeatherDayResponse),
  };
}

// ---------------------------------------------------------------------------------------------
// Farm daily history: daily candles of the farm series, aggregated from the 30-minute rollups the
// farm rollup job writes (src/wind/farm-rollup.ts); never from telemetry directly.

/** The widest range of the farm daily history: about 6 months of days. */
export const MAX_FARM_DAILY_RANGE_DAYS = 183;
/** A range of whole local days may be an hour longer than N × 24 h across a DST change. */
const DST_SLACK_MS = 60 * 60 * 1000;

/** A farm's daily history over a required [from, to) range (ISO instants, ≤ 183 days). */
export interface FarmDailyQuery extends TimeRange {
  /**
   * IANA zone of the days (default UTC). Send from/to at local midnights of this zone for whole
   * days: the range applies to the 30-minute buckets' start times.
   */
  timeZone?: string;
}

/** Per metric: open = the day's first bucket's open, close = its last's close, high/low over the day. */
const DAY_AGGREGATES = Prisma.raw(
  Object.values(FARM_ROLLUP_METRICS)
    .map(({ prefix: p }) =>
      [
        `(array_agg(r.${p}_open ORDER BY r.bucket_start))[1] AS ${p}_open`,
        `(array_agg(r.${p}_close ORDER BY r.bucket_start DESC))[1] AS ${p}_close`,
        `max(r.${p}_high) AS ${p}_high`,
        `min(r.${p}_low) AS ${p}_low`,
      ].join(', '),
    )
    .join(',\n'),
);

/**
 * A farm's series as one candle per local day in `timeZone` (default UTC; a DST day has 46 or 50
 * buckets), oldest first, aggregated in Postgres from farm_telemetry_rollups in [from, to) on the
 * bucket's start: about 8.8k primary-key rows for 6 months. Days without readings are omitted.
 * `turbines` per day is the most that reported in any of its buckets; `turbineCount` the farm's
 * turbines now; `computedAt` the newest computed_at among the rows (null when there are none).
 */
export async function farmDailyHistory(
  db: ReadClient,
  farmId: string,
  { from, to, timeZone = DEFAULT_WEATHER_TIME_ZONE }: FarmDailyQuery,
): Promise<FarmDailyHistoryResponse> {
  const farm = await db.farm.findUnique({
    where: { id: farmId },
    select: { id: true, _count: { select: { turbines: true } } },
  });
  if (!farm) throw new QueryNotFoundError(`Farm ${farmId} not found`);
  const start = new Date(from);
  const end = new Date(to);
  if (end <= start) throw new QueryInputError('to must be after from');
  if (
    end.getTime() - start.getTime() >
    MAX_FARM_DAILY_RANGE_DAYS * DAY_MS + DST_SLACK_MS
  ) {
    throw new QueryInputError(
      `The range may span at most ${MAX_FARM_DAILY_RANGE_DAYS} days`,
    );
  }
  const zone = await checkTimeZone(db, timeZone);

  // The local day of each bucket in the bound zone, as for the weather's daily rows.
  const rows = await db.$queryRaw<FarmDayRow[]>`
    SELECT
      to_char(r.bucket_start AT TIME ZONE ${zone}::text, 'YYYY-MM-DD') AS day,
      max(r.turbines)::int AS turbines,
      sum(r.readings)::int AS readings,
      max(r.computed_at) AS computed_at,
      ${DAY_AGGREGATES}
    FROM farm_telemetry_rollups r
    WHERE r.farm_id = ${farmId} AND r.bucket_start >= ${start} AND r.bucket_start < ${end}
    GROUP BY 1
    ORDER BY 1`;
  const computedAt = rows.reduce<Date | null>(
    (max, r) => (!max || r.computed_at > max ? r.computed_at : max),
    null,
  );
  return {
    farmId: farm.id,
    from: start.toISOString(),
    to: end.toISOString(),
    timeZone: zone,
    turbineCount: farm._count.turbines,
    computedAt: computedAt?.toISOString() ?? null,
    days: rows.map(toFarmDayResponse),
  };
}
