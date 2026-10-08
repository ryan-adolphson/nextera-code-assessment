import { Prisma } from '../generated/prisma/client.js';
import type { Telemetry } from '../generated/prisma/client.js';
import type { AlertLevel } from '../generated/prisma/enums.js';
import {
  toAlertConfigResponse,
  type AlertConfigResponse,
} from './alert-config.js';
import {
  TELEMETRY_ALERTS_INCLUDE,
  TELEMETRY_METRIC_COLUMNS,
  TELEMETRY_METRICS,
  toFarmResponse,
  toTelemetryResponse,
  toTelemetryStatsResponse,
  toTurbineResponse,
  type FarmResponse,
  type TelemetryMetric,
  type TelemetryResponse,
  type TelemetryStatsResponse,
  type TelemetryStatsRow,
  type TelemetryWithAlerts,
  type TurbineResponse,
} from './responses.js';

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
