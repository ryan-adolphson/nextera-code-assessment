import { Prisma } from '../generated/prisma/client.js';
import type { AlertConfig } from '../generated/prisma/client.js';
import { LIVE_REPORTING_MINUTES } from './live-summary.js';
import {
  toFarmResponse,
  toTelemetryResponse,
  type FarmResponse,
  type TelemetryResponse,
  type TurbineResponse,
} from './responses.js';
import {
  QueryInputError,
  QueryNotFoundError,
  parseRange,
  type ReadClient,
  type TimeRange,
} from './query-support.js';

/**
 * The fleet reads that stay fast at a million turbines (shared by the API and the MCP server):
 * live summaries from `farm_live_summary`, the keyset-paged turbine list from `turbines` +
 * `turbine_latest`, the farm's map markers and the paged alert history. None of them touches
 * `telemetry` except `alertsPage` (partition-pruned on the time range).
 */

/** The default and the widest page of the turbine list. */
export const DEFAULT_TURBINE_PAGE = 25;
export const MAX_TURBINE_PAGE = 100;
/** The turbine list counts matches up to this many; past it `totalCapped` is true. */
export const TURBINE_TOTAL_CAP = 10_000;
/** The most markers one farm's map returns. */
export const MAX_TURBINE_MARKERS = 2000;
/** Flagged readings per page of the alert history. */
export const DEFAULT_ALERT_PAGE = 500;
export const MAX_ALERT_PAGE = 1000;
/** Farms the free-text search resolves to farm ids (exact id first). */
const MAX_SEARCH_FARMS = 50;

// ---------------------------------------------------------------------------------------------
// Live summaries

export type TurbineStatus = 'reporting' | 'stale' | 'no_data';

export interface FleetSummary {
  farms: number;
  turbines: number;
  commissioned: number;
  reporting: number;
  stale: number;
  alerting: number;
  powerOutputKw: number;
  /** The oldest summary's computation time (ISO, UTC); null when none has run and none was needed. */
  asOf: string | null;
}

export interface FarmSummary extends FarmResponse {
  turbineCount: number;
  commissioned: number;
  reporting: number;
  stale: number;
  alerting: number;
  powerOutputKw: number;
  /** Mean wind of the reporting turbines; null if none report. */
  windSpeedMs: number | null;
  asOf: string | null;
}

interface Totals {
  farmId: string;
  turbines: number;
  commissioned: number;
  reporting: number;
  stale: number;
  alerting: number;
  powerOutputKw: number;
  windSpeedMs: number | null;
  asOf: Date;
}

/** The staleness reference of "reporting": newest reading at most LIVE_REPORTING_MINUTES old. */
const reportingSince = (now: Date): Date =>
  new Date(now.getTime() - LIVE_REPORTING_MINUTES * 60_000);

/**
 * Live totals computed from turbines + turbine_latest for the given farms: what the live-summary
 * job stores, used only for farms the job hasn't summarised yet (a fresh database, a new farm).
 */
async function computeTotals(
  db: ReadClient,
  farmIds: string[],
  now: Date,
): Promise<Totals[]> {
  if (!farmIds.length) return [];
  const since = reportingSince(now);
  const rows = await db.$queryRaw<
    {
      farm_id: string;
      turbines: number;
      commissioned: number;
      reporting: number;
      stale: number;
      alerting: number;
      power: number;
      wind: number | null;
    }[]
  >`
    SELECT t.farm_id,
           count(*)::int AS turbines,
           (count(*) FILTER (WHERE t.commissioned))::int AS commissioned,
           (count(*) FILTER (WHERE l."timestamp" >= ${since}))::int AS reporting,
           (count(*) FILTER (WHERE l."timestamp" < ${since}))::int AS stale,
           (count(*) FILTER (WHERE l."timestamp" >= ${since} AND l.worst_alert_level IS NOT NULL))::int AS alerting,
           coalesce(sum(l.power_output_kw) FILTER (WHERE l."timestamp" >= ${since}), 0)::float8 AS power,
           (avg(l.wind_speed_ms) FILTER (WHERE l."timestamp" >= ${since}))::float8 AS wind
    FROM turbines t
    LEFT JOIN turbine_latest l ON l.turbine_id = t.turbine_id
    WHERE t.farm_id = ANY(${farmIds}::text[])
    GROUP BY t.farm_id`;
  const byFarm = new Map(rows.map((r) => [r.farm_id, r]));
  return farmIds.map((farmId) => {
    const r = byFarm.get(farmId);
    return {
      farmId,
      turbines: r?.turbines ?? 0,
      commissioned: r?.commissioned ?? 0,
      reporting: r?.reporting ?? 0,
      stale: r?.stale ?? 0,
      alerting: r?.alerting ?? 0,
      powerOutputKw: r?.power ?? 0,
      windSpeedMs: r?.wind ?? null,
      asOf: now,
    };
  });
}

/**
 * Every farm with its live totals, no turbines: GET /api/farm-summaries. Reads `farm_live_summary`
 * (rebuilt every minute by the live-summary job); farms it hasn't summarised yet are computed from
 * turbine_latest on the spot, so a fresh database is correct before the first job run.
 */
export async function listFarmSummaries(
  db: ReadClient,
  { now = new Date() }: { now?: Date } = {},
): Promise<FarmSummary[]> {
  const farms = await db.farm.findMany({
    orderBy: { id: 'asc' },
    include: { liveSummary: true },
  });
  const missing = await computeTotals(
    db,
    farms.filter((f) => !f.liveSummary).map((f) => f.id),
    now,
  );
  const computed = new Map(missing.map((t) => [t.farmId, t]));
  return farms.map((farm) => {
    const s = farm.liveSummary;
    const totals: Totals = s
      ? {
          farmId: farm.id,
          turbines: s.turbines,
          commissioned: s.commissioned,
          reporting: s.reporting,
          stale: s.stale,
          alerting: s.alerting,
          powerOutputKw: s.powerOutputKw,
          windSpeedMs: s.windSpeedMs,
          asOf: s.asOf,
        }
      : computed.get(farm.id)!;
    return {
      ...toFarmResponse(farm),
      turbineCount: totals.turbines,
      commissioned: totals.commissioned,
      reporting: totals.reporting,
      stale: totals.stale,
      alerting: totals.alerting,
      powerOutputKw: totals.powerOutputKw,
      windSpeedMs: totals.windSpeedMs,
      asOf: totals.asOf.toISOString(),
    };
  });
}

/** The fleet's totals: GET /api/fleet/summary. One aggregate over farm_live_summary. */
export async function fleetSummary(
  db: ReadClient,
  { now = new Date() }: { now?: Date } = {},
): Promise<FleetSummary> {
  const [row] = await db.$queryRaw<
    {
      farms: number;
      summarised: number;
      turbines: number;
      commissioned: number;
      reporting: number;
      stale: number;
      alerting: number;
      power: number;
      as_of: Date | null;
    }[]
  >`
    SELECT (SELECT count(*) FROM farms)::int AS farms,
           count(*)::int AS summarised,
           coalesce(sum(turbines), 0)::int AS turbines,
           coalesce(sum(commissioned), 0)::int AS commissioned,
           coalesce(sum(reporting), 0)::int AS reporting,
           coalesce(sum(stale), 0)::int AS stale,
           coalesce(sum(alerting), 0)::int AS alerting,
           coalesce(sum(power_output_kw), 0)::float8 AS power,
           min(as_of) AS as_of
    FROM farm_live_summary`;
  const summary: FleetSummary = {
    farms: row.farms,
    turbines: row.turbines,
    commissioned: row.commissioned,
    reporting: row.reporting,
    stale: row.stale,
    alerting: row.alerting,
    powerOutputKw: row.power,
    asOf: row.as_of?.toISOString() ?? null,
  };
  if (row.summarised < row.farms) {
    const unsummarised = await db.$queryRaw<{ id: string }[]>`
      SELECT f.id FROM farms f
      WHERE NOT EXISTS (SELECT 1 FROM farm_live_summary s WHERE s.farm_id = f.id)`;
    for (const t of await computeTotals(
      db,
      unsummarised.map((f) => f.id),
      now,
    )) {
      summary.turbines += t.turbines;
      summary.commissioned += t.commissioned;
      summary.reporting += t.reporting;
      summary.stale += t.stale;
      summary.alerting += t.alerting;
      summary.powerOutputKw += t.powerOutputKw;
    }
    summary.asOf = [summary.asOf, now.toISOString()]
      .filter((v): v is string => v !== null)
      .sort()[0]!;
  }
  return summary;
}

// ---------------------------------------------------------------------------------------------
// Readings' alerts

/** The rules each reading triggered, loaded for a page of readings: one query for all of them. */
async function alertsForReadings(
  db: ReadClient,
  readings: { id: string; timestamp: Date }[],
): Promise<Map<string, AlertConfig[]>> {
  const byReading = new Map<string, AlertConfig[]>();
  if (!readings.length) return byReading;
  const links = await db.$queryRaw<
    { telemetry_id: string; alert_id: string }[]
  >`
    SELECT ta.telemetry_id, ta.alert_id
    FROM telemetry_alerts ta
    JOIN unnest(${readings.map((r) => r.id)}::uuid[], ${readings.map((r) => r.timestamp.toISOString())}::timestamptz[])
      AS k(id, ts) ON ta.telemetry_id = k.id AND ta.reading_timestamp = k.ts`;
  if (!links.length) return byReading;
  const rules = new Map(
    (
      await db.alertConfig.findMany({
        where: { id: { in: [...new Set(links.map((l) => l.alert_id))] } },
      })
    ).map((rule) => [rule.id, rule]),
  );
  for (const link of links) {
    const rule = rules.get(link.alert_id);
    if (!rule) continue;
    byReading.set(link.telemetry_id, [
      ...(byReading.get(link.telemetry_id) ?? []),
      rule,
    ]);
  }
  return byReading;
}

/** Raw columns of a turbine_latest row, as selected by the list and single-turbine queries. */
interface LatestColumns {
  reading_id: string | null;
  l_timestamp: Date | null;
  received_at: Date | null;
  power_output_kw: number | null;
  wind_speed_ms: number | null;
  rotor_rpm: number | null;
  blade_pitch_deg: number | null;
  gearbox_temp_c: number | null;
}

const LATEST_SELECT = Prisma.raw(`
  l.reading_id, l."timestamp" AS l_timestamp, l.received_at, l.power_output_kw, l.wind_speed_ms,
  l.rotor_rpm, l.blade_pitch_deg, l.gearbox_temp_c`);

/** The latest readings (turbine_latest, with their rules) of the given turbines, by turbine id. */
export async function latestReadings(
  db: ReadClient,
  turbineIds: string[],
): Promise<Map<string, TelemetryResponse>> {
  const out = new Map<string, TelemetryResponse>();
  if (!turbineIds.length) return out;
  const rows = await db.$queryRaw<
    (LatestColumns & { turbine_id: string; farm_id: string })[]
  >`
    SELECT l.turbine_id, l.farm_id, ${LATEST_SELECT}
    FROM turbine_latest l
    WHERE l.turbine_id = ANY(${turbineIds}::text[])`;
  const alerts = await alertsForReadings(
    db,
    rows.map((r) => ({ id: r.reading_id!, timestamp: r.l_timestamp! })),
  );
  for (const row of rows) {
    const latest = toLatest(row.turbine_id, row.farm_id, row, alerts);
    if (latest) out.set(row.turbine_id, latest);
  }
  return out;
}

/** Builds the `latest` of a row (null when the turbine has no row in turbine_latest). */
function toLatest(
  turbineId: string,
  farmId: string,
  row: LatestColumns,
  alerts: Map<string, AlertConfig[]>,
): TelemetryResponse | null {
  if (!row.reading_id || !row.l_timestamp) return null;
  return toTelemetryResponse({
    id: row.reading_id,
    turbineId,
    farmId,
    timestamp: row.l_timestamp,
    receivedAt: row.received_at!,
    createdAt: row.received_at!,
    powerOutputKw: row.power_output_kw!,
    windSpeedMs: row.wind_speed_ms!,
    rotorRpm: row.rotor_rpm!,
    bladePitchDeg: row.blade_pitch_deg!,
    gearboxTempC: row.gearbox_temp_c!,
    alerts: (alerts.get(row.reading_id) ?? []).map((alert) => ({ alert })),
  });
}

// ---------------------------------------------------------------------------------------------
// The turbine list

export const TURBINE_SORTS = [
  'id',
  'farm',
  'commissioned',
  'time',
  'power',
  'wind',
  'gearbox',
] as const;
export type TurbineSort = (typeof TURBINE_SORTS)[number];
export const TURBINE_STATUSES = ['reporting', 'stale', 'no_data'] as const;

/** Sorts on a reading value: only within one farm (their order isn't indexed fleet-wide). */
const METRIC_SORT_COLUMN: Partial<Record<TurbineSort, string>> = {
  power: 'power_output_kw',
  wind: 'wind_speed_ms',
  gearbox: 'gearbox_temp_c',
};
/** Sorts whose key lives in turbine_latest: turbines without a reading sort after all others. */
const LATEST_SORT_COLUMN: Partial<Record<TurbineSort, string>> = {
  time: '"timestamp"',
  ...METRIC_SORT_COLUMN,
};

export interface TurbineListQuery {
  farmId?: string;
  /** Case-insensitive substring of the turbine id, or a farm's id or name. */
  q?: string;
  status?: TurbineStatus;
  commissioned?: boolean;
  /** true: turbines with a reading; false: without. */
  hasData?: boolean;
  sort?: TurbineSort;
  dir?: 'asc' | 'desc';
  limit?: number;
  /** An opaque cursor from a previous page's `nextCursor` / `prevCursor`. */
  cursor?: string;
  /** The staleness reference (default now). */
  now?: Date;
}

export interface TurbineListItem extends TurbineResponse {
  farmName: string;
  latest: TelemetryResponse | null;
}

export interface TurbineListResponse {
  items: TurbineListItem[];
  nextCursor: string | null;
  prevCursor: string | null;
  /** Matches, counted up to TURBINE_TOTAL_CAP. */
  total: number;
  totalCapped: boolean;
}

/** A boundary position: the sort key (null = no value) and the turbine id of an item. */
interface Cursor {
  /** `a`: the items after this position, `b`: the items before it. */
  b: 'a' | 'b';
  s: TurbineSort;
  d: 'asc' | 'desc';
  k: string | number | boolean | null;
  i: string;
}

const encodeCursor = (cursor: Cursor): string =>
  Buffer.from(JSON.stringify(cursor)).toString('base64url');

function decodeCursor(raw: string, sort: TurbineSort, dir: string): Cursor {
  const bad = () => new QueryInputError('Invalid cursor');
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  if (typeof value !== 'object' || value === null) throw bad();
  const c = value as Record<string, unknown>;
  if (c.b !== 'a' && c.b !== 'b') throw bad();
  if (typeof c.i !== 'string' || c.i === '') throw bad();
  if (c.s !== sort || c.d !== dir) {
    throw new QueryInputError('The cursor belongs to a different sort');
  }
  const nullable = sort in LATEST_SORT_COLUMN;
  if (sort === 'id') {
    if (c.k !== null && c.k !== undefined) throw bad();
  } else if (c.k === null || c.k === undefined) {
    if (!nullable) throw bad();
  } else if (
    typeof c.k !==
    (sort === 'commissioned'
      ? 'boolean'
      : sort === 'farm' || sort === 'time'
        ? 'string'
        : 'number')
  ) {
    throw bad();
  } else if (
    (sort === 'time' && Number.isNaN(Date.parse(c.k as string))) ||
    (typeof c.k === 'number' && !Number.isFinite(c.k))
  ) {
    throw bad();
  }
  return {
    b: c.b,
    s: sort,
    d: dir as 'asc' | 'desc',
    k: (c.k as Cursor['k']) ?? null,
    i: c.i,
  };
}

/** One contiguous part of the sort order: `value` rows have a reading, `none` rows don't. */
type Segment = 'all' | 'value' | 'none';

interface ListRow extends LatestColumns {
  turbine_id: string;
  farm_id: string;
  farm_name: string;
  latitude: Prisma.Decimal;
  longitude: Prisma.Decimal;
  commissioned: boolean;
}

const escapeLike = (text: string): string => text.replace(/[\\%_]/g, '\\$&');

/**
 * The turbines page: GET /api/turbines. Filters, a sort and keyset paging over `turbines` joined to
 * `turbine_latest` (the latest reading); no scan of telemetry.
 *
 * - Sort: `id` (default), `farm`, `commissioned`, `time` (the latest reading's measurement time),
 *   and `power` / `wind` / `gearbox` (the latest value; they need `farmId`: only a farm's turbines
 *   are sorted in memory-sized sets). `dir` flips the key and the id tie-break together. A turbine
 *   without a reading sorts last in either direction, by id.
 * - Keyset: a cursor is a POSITION in the order (sort key and id of the boundary item, plus the
 *   direction), not a row id, so it keeps working if that row changes or disappears. Rows added,
 *   removed or changed while paging can appear or vanish; one whose key moves across the boundary
 *   between two pages is skipped or shown twice (what keyset allows: it never re-reads earlier
 *   pages). Nothing is skipped or repeated while the data doesn't change. `prevCursor` is set for
 *   every page reached from a cursor that has earlier rows (the first page has none).
 * - `q`: a case-insensitive substring of the turbine id (trigram index), or a farm whose id or name
 *   contains it (at most MAX_SEARCH_FARMS farms, an exact id first).
 * - `total`: from farm_live_summary when only `farmId` / `commissioned` filter (exact, and
 *   `totalCapped` false), else counted up to TURBINE_TOTAL_CAP (`totalCapped` true past it).
 */
export async function listTurbines(
  db: ReadClient,
  query: TurbineListQuery,
): Promise<TurbineListResponse> {
  const sort = query.sort ?? 'id';
  const dir = query.dir ?? 'asc';
  const limit = query.limit ?? DEFAULT_TURBINE_PAGE;
  const now = query.now ?? new Date();
  if (!TURBINE_SORTS.includes(sort)) {
    throw new QueryInputError(
      `sort must be one of ${TURBINE_SORTS.join(', ')}`,
    );
  }
  if (dir !== 'asc' && dir !== 'desc') {
    throw new QueryInputError('dir must be asc or desc');
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_TURBINE_PAGE) {
    throw new QueryInputError(`limit must be 1 to ${MAX_TURBINE_PAGE}`);
  }
  if (sort in METRIC_SORT_COLUMN && !query.farmId) {
    throw new QueryInputError(
      `Sorting by ${sort} needs a farmId: readings can only be sorted within one farm`,
    );
  }
  const cursor = query.cursor
    ? decodeCursor(query.cursor, sort, dir)
    : undefined;

  const since = reportingSince(now);
  const q = query.q?.trim();
  const search = q ? await searchPredicate(db, q) : undefined;
  const base: Prisma.Sql[] = [];
  if (query.farmId) base.push(Prisma.sql`t.farm_id = ${query.farmId}`);
  if (query.commissioned !== undefined) {
    base.push(Prisma.sql`t.commissioned = ${query.commissioned}`);
  }
  if (search) base.push(search);

  // Which parts of the order can contain rows given status / hasData.
  const wantsValue = query.status !== 'no_data' && query.hasData !== false;
  const wantsNone =
    (query.status === undefined || query.status === 'no_data') &&
    query.hasData !== true;
  const valueFilters: Prisma.Sql[] = [];
  if (query.status === 'reporting') {
    valueFilters.push(Prisma.sql`l."timestamp" >= ${since}`);
  }
  if (query.status === 'stale') {
    valueFilters.push(Prisma.sql`l."timestamp" < ${since}`);
  }
  const keyedByLatest = sort in LATEST_SORT_COLUMN;
  const segments: Segment[] = keyedByLatest
    ? [
        ...(wantsValue ? (['value'] as const) : []),
        ...(wantsNone ? (['none'] as const) : []),
      ]
    : wantsValue || wantsNone
      ? ['all']
      : [];

  const segmentWhere = (segment: Segment): Prisma.Sql[] => {
    if (segment === 'none') return [...base, Prisma.sql`l.turbine_id IS NULL`];
    if (segment === 'value') return [...base, ...valueFilters];
    // 'all': a LEFT JOIN, so status / hasData become conditions on l.
    const where = [...base, ...valueFilters];
    if (query.status === 'no_data' || query.hasData === false) {
      where.push(Prisma.sql`l.turbine_id IS NULL`);
    }
    if (query.hasData === true)
      where.push(Prisma.sql`l.turbine_id IS NOT NULL`);
    return where;
  };

  const rows = await fetchPage(db, {
    sort,
    dir,
    limit,
    cursor,
    segments,
    segmentWhere,
  });

  const alerts = await alertsForReadings(
    db,
    rows.items.flatMap((r) =>
      r.reading_id && r.l_timestamp
        ? [{ id: r.reading_id, timestamp: r.l_timestamp }]
        : [],
    ),
  );
  const items: TurbineListItem[] = rows.items.map((r) => ({
    id: r.turbine_id,
    farmId: r.farm_id,
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
    commissioned: r.commissioned,
    farmName: r.farm_name,
    latest: toLatest(r.turbine_id, r.farm_id, r, alerts),
  }));

  const keyOf = (row: ListRow): Cursor['k'] => {
    switch (sort) {
      case 'id':
        return null;
      case 'farm':
        return row.farm_id;
      case 'commissioned':
        return row.commissioned;
      case 'time':
        return row.l_timestamp?.toISOString() ?? null;
      case 'power':
        return row.power_output_kw;
      case 'wind':
        return row.wind_speed_ms;
      case 'gearbox':
        return row.gearbox_temp_c;
    }
  };
  const cursorAt = (row: ListRow, b: 'a' | 'b'): string =>
    encodeCursor({ b, s: sort, d: dir, k: keyOf(row), i: row.turbine_id });
  const first = rows.items[0];
  const last = rows.items.at(-1);

  const nextCursor =
    last && (rows.hasMore || cursor?.b === 'b') ? cursorAt(last, 'a') : null;
  const prevCursor =
    first && (cursor?.b === 'b' ? rows.hasMore : cursor !== undefined)
      ? cursorAt(first, 'b')
      : null;

  const total = await countTurbines(db, {
    query,
    base,
    valueFilters,
    wantsValue,
    wantsNone,
    since,
  });
  return { items, nextCursor, prevCursor, ...total };
}

/** `(turbine id contains q) OR (farm_id IN matching farms)`; the farms are resolved first. */
async function searchPredicate(db: ReadClient, q: string): Promise<Prisma.Sql> {
  const pattern = `%${escapeLike(q)}%`;
  const farms = await db.$queryRaw<{ id: string }[]>`
    SELECT id FROM farms
    WHERE id ILIKE ${pattern} OR name ILIKE ${pattern}
    ORDER BY (lower(id) = lower(${q})) DESC, id
    LIMIT ${MAX_SEARCH_FARMS}`;
  const ids = farms.map((f) => f.id);
  return ids.length
    ? Prisma.sql`(t.turbine_id ILIKE ${pattern} OR t.farm_id = ANY(${ids}::text[]))`
    : Prisma.sql`t.turbine_id ILIKE ${pattern}`;
}

interface PageRequest {
  sort: TurbineSort;
  dir: 'asc' | 'desc';
  limit: number;
  cursor: Cursor | undefined;
  segments: Segment[];
  segmentWhere: (segment: Segment) => Prisma.Sql[];
}

/** The key column of a sort within a segment (undefined: the id alone orders). */
function keyColumn(sort: TurbineSort): Prisma.Sql | undefined {
  if (sort === 'farm') return Prisma.sql`t.farm_id`;
  if (sort === 'commissioned') return Prisma.sql`t.commissioned`;
  const column = LATEST_SORT_COLUMN[sort];
  return column ? Prisma.raw(`l.${column}`) : undefined;
}

/** `::type` of the key, so row comparisons against bound parameters type-check. */
const KEY_CAST: Record<TurbineSort, string> = {
  id: 'text',
  farm: 'text',
  commissioned: 'boolean',
  time: 'timestamptz',
  power: 'float8',
  wind: 'float8',
  gearbox: 'float8',
};

/** Position of a segment in the forward order (`all` and `value` come first, `none` last). */
const segmentRank = (segment: Segment): number => (segment === 'none' ? 1 : 0);

/**
 * Reads one page: `limit` + 1 items after (or before) the cursor, segment by segment (a segment
 * is one index-friendly query; a page that runs past the end of one continues in the next).
 */
async function fetchPage(
  db: ReadClient,
  req: PageRequest,
): Promise<{ items: ListRow[]; hasMore: boolean }> {
  const { sort, limit, cursor, segments } = req;
  const backwards = cursor?.b === 'b';
  const need = limit + 1;
  const ordered = backwards ? [...segments].reverse() : segments;
  // The cursor sits in the rows without a reading when its key is null (a latest-keyed sort).
  const cursorRank =
    cursor && sort in LATEST_SORT_COLUMN && cursor.k === null ? 1 : 0;

  const collected: ListRow[] = [];
  for (const segment of ordered) {
    if (collected.length >= need) break;
    const rank = segmentRank(segment);
    // Segments on the far side of the cursor were read already; the cursor's own segment starts
    // at it, and the ones beyond are read whole.
    if (cursor && (backwards ? rank > cursorRank : rank < cursorRank)) continue;
    const position = cursor && rank === cursorRank ? cursor : undefined;
    collected.push(
      ...(await readSegment(
        db,
        req,
        segment,
        position,
        need - collected.length,
        backwards,
      )),
    );
  }
  const hasMore = collected.length > limit;
  const items = collected.slice(0, limit);
  if (backwards) items.reverse();
  return { items, hasMore };
}

async function readSegment(
  db: ReadClient,
  req: PageRequest,
  segment: Segment,
  position: Cursor | undefined,
  n: number,
  backwards: boolean,
): Promise<ListRow[]> {
  const { sort, dir } = req;
  // Reading order: `dir`, flipped when going backwards.
  const descending = (dir === 'desc') !== backwards;
  const direction = descending ? Prisma.raw('DESC') : Prisma.raw('ASC');
  const idColumn =
    segment === 'value' ? Prisma.sql`l.turbine_id` : Prisma.sql`t.turbine_id`;
  const key = segment === 'none' ? undefined : keyColumn(sort);

  const where = [...req.segmentWhere(segment)];
  // A segment read in id order (the id sort, or the rows without a reading) is joined to
  // turbine_latest by merge join, which would read it from the start however deep the cursor is;
  // the same bound on its side of the join (it only drops ids that couldn't match) prevents that.
  let latestBound = Prisma.empty;
  if (position) {
    // Items after the position in the sort order: greater when ascending, less when descending
    // (and the reverse for "before"): one row comparison, so the index serves it.
    const after = (dir === 'asc') !== (position.b === 'b');
    const op = Prisma.raw(after ? '>' : '<');
    if (!key || position.k === null) {
      latestBound = Prisma.sql`AND l.turbine_id ${op} ${position.i}::text`;
    }
    if (key && position.k !== null) {
      where.push(
        Prisma.sql`(${key}, ${idColumn}) ${op} (${position.k}::${Prisma.raw(KEY_CAST[sort])}, ${position.i}::text)`,
      );
    } else {
      where.push(Prisma.sql`${idColumn} ${op} ${position.i}::text`);
    }
  }
  const order = key
    ? Prisma.sql`${key} ${direction}, ${idColumn} ${direction}`
    : Prisma.sql`${idColumn} ${direction}`;
  const from =
    segment === 'value'
      ? Prisma.sql`turbine_latest l JOIN turbines t ON t.turbine_id = l.turbine_id`
      : Prisma.sql`turbines t LEFT JOIN turbine_latest l ON l.turbine_id = t.turbine_id ${latestBound}`;
  return db.$queryRaw<ListRow[]>`
    SELECT t.turbine_id, t.farm_id, t.latitude, t.longitude, t.commissioned, f.name AS farm_name,
           ${LATEST_SELECT}
    FROM ${from}
    JOIN farms f ON f.id = t.farm_id
    ${where.length ? Prisma.sql`WHERE ${Prisma.join(where, ' AND ')}` : Prisma.empty}
    ORDER BY ${order}
    LIMIT ${n}`;
}

/** The total: from the live summaries when the filter allows, else counted up to the cap. */
async function countTurbines(
  db: ReadClient,
  input: {
    query: TurbineListQuery;
    base: Prisma.Sql[];
    valueFilters: Prisma.Sql[];
    wantsValue: boolean;
    wantsNone: boolean;
    since: Date;
  },
): Promise<{ total: number; totalCapped: boolean }> {
  const { query, base, valueFilters, wantsValue, wantsNone } = input;
  if (!wantsValue && !wantsNone) return { total: 0, totalCapped: false };

  if (!query.q && !query.status && query.hasData === undefined) {
    const exact = await summaryTotal(db, query.farmId, query.commissioned);
    if (exact !== undefined) return { total: exact, totalCapped: false };
  }

  const where = [...base, ...valueFilters];
  if (query.status === 'no_data' || query.hasData === false) {
    where.push(Prisma.sql`l.turbine_id IS NULL`);
  }
  if (query.hasData === true) where.push(Prisma.sql`l.turbine_id IS NOT NULL`);
  const needsLatest =
    valueFilters.length > 0 ||
    query.status !== undefined ||
    query.hasData !== undefined;
  const [{ n }] = await db.$queryRaw<{ n: number }[]>`
    SELECT count(*)::int AS n FROM (
      SELECT 1 FROM turbines t
      ${needsLatest ? Prisma.sql`LEFT JOIN turbine_latest l ON l.turbine_id = t.turbine_id` : Prisma.empty}
      ${where.length ? Prisma.sql`WHERE ${Prisma.join(where, ' AND ')}` : Prisma.empty}
      LIMIT ${TURBINE_TOTAL_CAP + 1}
    ) c`;
  return n > TURBINE_TOTAL_CAP
    ? { total: TURBINE_TOTAL_CAP, totalCapped: true }
    : { total: n, totalCapped: false };
}

/**
 * The exact count of a farm's (or the whole fleet's) turbines, commissioned or not, from
 * farm_live_summary; undefined when it is incomplete (a farm not summarised yet).
 */
async function summaryTotal(
  db: ReadClient,
  farmId: string | undefined,
  commissioned: boolean | undefined,
): Promise<number | undefined> {
  const [row] = await db.$queryRaw<
    {
      farms: number;
      summarised: number;
      turbines: number;
      commissioned: number;
    }[]
  >`
    SELECT ${farmId ? Prisma.sql`1` : Prisma.sql`(SELECT count(*) FROM farms)`}::int AS farms,
           count(*)::int AS summarised,
           coalesce(sum(turbines), 0)::int AS turbines,
           coalesce(sum(commissioned), 0)::int AS commissioned
    FROM farm_live_summary
    ${farmId ? Prisma.sql`WHERE farm_id = ${farmId}` : Prisma.empty}`;
  if (row.summarised < row.farms) return undefined;
  if (commissioned === undefined) return row.turbines;
  return commissioned ? row.commissioned : row.turbines - row.commissioned;
}

/** One turbine in the list's shape, 404 if unknown: GET /api/turbines/:id. */
export async function turbineItem(
  db: ReadClient,
  turbineId: string,
): Promise<TurbineListItem> {
  const [row] = await db.$queryRaw<ListRow[]>`
    SELECT t.turbine_id, t.farm_id, t.latitude, t.longitude, t.commissioned, f.name AS farm_name,
           ${LATEST_SELECT}
    FROM turbines t
    JOIN farms f ON f.id = t.farm_id
    LEFT JOIN turbine_latest l ON l.turbine_id = t.turbine_id
    WHERE t.turbine_id = ${turbineId}`;
  if (!row) throw new QueryNotFoundError(`Turbine ${turbineId} not found`);
  const alerts = await alertsForReadings(
    db,
    row.reading_id && row.l_timestamp
      ? [{ id: row.reading_id, timestamp: row.l_timestamp }]
      : [],
  );
  return {
    id: row.turbine_id,
    farmId: row.farm_id,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    commissioned: row.commissioned,
    farmName: row.farm_name,
    latest: toLatest(row.turbine_id, row.farm_id, row, alerts),
  };
}

// ---------------------------------------------------------------------------------------------
// Map markers

export interface TurbineMarker {
  id: string;
  latitude: number;
  longitude: number;
  status: TurbineStatus;
  /** Measurement time of the latest reading (ISO, UTC); null if none. */
  timestamp: string | null;
}

/** A farm's turbines for its map (at most MAX_TURBINE_MARKERS, by id); 404 for an unknown farm. */
export async function turbineMarkers(
  db: ReadClient,
  farmId: string,
  { now = new Date() }: { now?: Date } = {},
): Promise<TurbineMarker[]> {
  const farm = await db.farm.findUnique({
    where: { id: farmId },
    select: { id: true },
  });
  if (!farm) throw new QueryNotFoundError(`Farm ${farmId} not found`);
  const since = reportingSince(now);
  const rows = await db.$queryRaw<
    {
      turbine_id: string;
      latitude: Prisma.Decimal;
      longitude: Prisma.Decimal;
      ts: Date | null;
    }[]
  >`
    SELECT t.turbine_id, t.latitude, t.longitude, l."timestamp" AS ts
    FROM turbines t
    LEFT JOIN turbine_latest l ON l.turbine_id = t.turbine_id
    WHERE t.farm_id = ${farmId}
    ORDER BY t.turbine_id
    LIMIT ${MAX_TURBINE_MARKERS}`;
  return rows.map((r) => ({
    id: r.turbine_id,
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
    status: r.ts === null ? 'no_data' : r.ts >= since ? 'reporting' : 'stale',
    timestamp: r.ts?.toISOString() ?? null,
  }));
}

// ---------------------------------------------------------------------------------------------
// Alert history

export interface AlertsPageQuery extends TimeRange {
  limit?: number;
  cursor?: string;
}

export interface AlertsPage {
  /** Flagged readings with their rules, newest first (ties by reading id). */
  items: TelemetryResponse[];
  nextCursor: string | null;
}

/**
 * The readings measured in [from, to) that triggered at least one rule, newest first, one page at
 * a time (default 500, at most 1000): GET /api/alerts. Reads `telemetry_alerts` by its reading
 * time (partitions outside the range are pruned, an index serves the order), then loads just the
 * page's readings by (id, timestamp). Keyset: a cursor is the (time, reading id) after which the
 * next page starts. Disabled rules still show on the readings they flagged.
 */
export async function alertsPage(
  db: ReadClient,
  { from, to, limit = DEFAULT_ALERT_PAGE, cursor }: AlertsPageQuery,
): Promise<AlertsPage> {
  const { start, end } = parseRange(from, to);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_ALERT_PAGE) {
    throw new QueryInputError(`limit must be 1 to ${MAX_ALERT_PAGE}`);
  }
  let after = Prisma.empty;
  if (cursor) {
    const c = decodeAlertCursor(cursor);
    after = Prisma.sql`AND (reading_timestamp, telemetry_id) < (${c.at}::timestamptz, ${c.id}::uuid)`;
  }
  const keys = await db.$queryRaw<
    { telemetry_id: string; reading_timestamp: Date }[]
  >`
    SELECT telemetry_id, reading_timestamp
    FROM telemetry_alerts
    WHERE reading_timestamp >= ${start} AND reading_timestamp < ${end} ${after}
    GROUP BY reading_timestamp, telemetry_id
    ORDER BY reading_timestamp DESC, telemetry_id DESC
    LIMIT ${limit + 1}`;
  const page = keys.slice(0, limit);
  const readings = await db.$queryRaw<
    {
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
    }[]
  >`
    SELECT t.*
    FROM telemetry t
    JOIN unnest(${page.map((k) => k.telemetry_id)}::uuid[], ${page.map((k) => k.reading_timestamp.toISOString())}::timestamptz[])
      AS k(id, ts) ON t.id = k.id AND t."timestamp" = k.ts`;
  const alerts = await alertsForReadings(
    db,
    page.map((k) => ({ id: k.telemetry_id, timestamp: k.reading_timestamp })),
  );
  const byId = new Map(readings.map((r) => [r.id, r]));
  const items = page.flatMap((k) => {
    const r = byId.get(k.telemetry_id);
    if (!r) return []; // deleted between the two reads
    return [
      toTelemetryResponse({
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
        alerts: (alerts.get(r.id) ?? []).map((alert) => ({ alert })),
      }),
    ];
  });
  const lastKey = page.at(-1);
  return {
    items,
    nextCursor:
      keys.length > limit && lastKey
        ? Buffer.from(
            JSON.stringify({
              at: lastKey.reading_timestamp.toISOString(),
              id: lastKey.telemetry_id,
            }),
          ).toString('base64url')
        : null,
  };
}

function decodeAlertCursor(raw: string): { at: string; id: string } {
  const bad = () => new QueryInputError('Invalid cursor');
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    throw bad();
  }
  const c = value as { at?: unknown; id?: unknown } | null;
  if (
    typeof c !== 'object' ||
    c === null ||
    typeof c.at !== 'string' ||
    Number.isNaN(Date.parse(c.at)) ||
    typeof c.id !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      c.id,
    )
  ) {
    throw bad();
  }
  return { at: c.at, id: c.id };
}
