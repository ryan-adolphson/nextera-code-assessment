import { Prisma } from '../generated/prisma/client.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { TelemetryMetric } from './responses.js';

/**
 * The farm rollup: 30-minute buckets of each farm's telemetry series in farm_telemetry_rollups,
 * from which GET /api/farms/:farmId/telemetry/daily builds daily candles in any time zone.
 * Run by `node dist/farm-rollup/main.js` (Cloud Run Job every 15 min, compose `farm-rollup`),
 * `npm run rollup`, and after `db:seed`, `db:seed:demo` and `demo:reset`.
 *
 * The farm series has one point per measurement timestamp: power is the sum over the turbines that
 * reported at that timestamp, the other metrics their mean. A bucket stores, per metric, the first
 * (open) and last (close) point, the high and the low, plus its readings and distinct turbines.
 *
 * One run is one transaction (so a failed run changes nothing, the watermark included):
 *   1. `pg_try_advisory_xact_lock`: another run in progress → skipped (not an error).
 *   2. Targets, per farm the earliest bucket to recompute: telemetry rows created since the
 *      watermark (minus FARM_ROLLUP_LOOKBACK_MS) by their earliest measurement time (late readings,
 *      CSV backfills, imported held readings), the dirty markers (moves; consumed), and the current
 *      UTC day of every farm. The first run (no watermark), --full and --from add every farm.
 *   3. Deletes each target farm's rows from its bucket on and inserts them again from telemetry
 *      (so buckets a moved turbine left disappear), then prunes rows older than the retention.
 *   4. Saves the watermark: the database time at which this run started.
 */

/** Width of a rollup bucket. */
/** SSE event (global stream): a farm rollup run committed. Payload `FarmRollupCompletedEvent`. */
export const FARM_ROLLUP_COMPLETED = 'farm-rollup.completed';

/** Payload of `farm-rollup.completed`: global, no farm ids. */
export interface FarmRollupCompletedEvent {
  /** The run's watermark (ISO, UTC). */
  asOf: string;
}

export const FARM_ROLLUP_BUCKET_MINUTES = 30;
/** Rollups older than this before the newest reading (or now, whichever is earlier) are pruned. */
export const FARM_ROLLUP_RETENTION_DAYS = 190;
/**
 * The incremental scan re-reads rows created this long before the watermark: created_at is the
 * inserting transaction's start time, so a row committed after a run started can carry an older
 * created_at. Covers any write transaction up to this long (the longest, an Unallocated import,
 * times out after 60 s). Recomputing is idempotent, so the overlap only costs a little work.
 */
export const FARM_ROLLUP_LOOKBACK_MS = 10 * 60_000;
/** Key of the advisory lock that keeps runs from overlapping. */
export const FARM_ROLLUP_LOCK = 'farm-rollup';
/** A run's transaction timeout (a --full run over 6 months of a large fleet takes a while). */
export const FARM_ROLLUP_TIMEOUT_MS = 15 * 60_000;

const BUCKET_MS = FARM_ROLLUP_BUCKET_MINUTES * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/**
 * Column prefix of each metric in farm_telemetry_rollups (`<prefix>_open|_close|_high|_low`), the
 * telemetry column and how the farm series combines the turbines at one timestamp. Fixed
 * constants, never user input (they go into SQL with Prisma.raw).
 */
export const FARM_ROLLUP_METRICS: Record<
  TelemetryMetric,
  { prefix: string; column: string; combine: 'sum' | 'avg' }
> = {
  powerOutputKw: { prefix: 'power', column: 'power_output_kw', combine: 'sum' },
  windSpeedMs: {
    prefix: 'wind_speed',
    column: 'wind_speed_ms',
    combine: 'avg',
  },
  rotorRpm: { prefix: 'rotor_rpm', column: 'rotor_rpm', combine: 'avg' },
  bladePitchDeg: {
    prefix: 'blade_pitch',
    column: 'blade_pitch_deg',
    combine: 'avg',
  },
  gearboxTempC: {
    prefix: 'gearbox_temp',
    column: 'gearbox_temp_c',
    combine: 'avg',
  },
};
const METRICS = Object.values(FARM_ROLLUP_METRICS);

export type FarmRollupMode =
  | { kind: 'incremental' }
  | { kind: 'full' }
  /** Every farm from this UTC day (YYYY-MM-DD) on, plus the incremental targets. */
  | { kind: 'from'; day: string };

export interface FarmRollupOptions {
  /** Default incremental. */
  mode?: FarmRollupMode;
  /** The clock for the current day and the retention (default now). */
  now?: Date;
  timeoutMs?: number;
}

export interface FarmRollupResult {
  /** Another run held the lock: nothing was done. */
  skipped: boolean;
  /** No watermark yet: every farm was recomputed from the retention cutoff. */
  firstRun: boolean;
  /** Farms recomputed. */
  farms: number;
  /** The earliest bucket recomputed (ISO); null when none. */
  from: string | null;
  /** Rollup rows written, and deleted before (rewritten or gone), and pruned. */
  written: number;
  deleted: number;
  pruned: number;
  /** Dirty markers consumed. */
  dirty: number;
  /** Rows older than this are pruned and never recomputed (ISO). */
  cutoff: string;
  /** The saved watermark (ISO); null when skipped. */
  watermark: string | null;
}

/** The client a run needs: its own transaction. */
export type FarmRollupClient = Pick<PrismaClient, '$transaction'>;

/** The start of the 30-minute bucket of `t`. */
export const floorToBucket = (t: Date): Date =>
  new Date(Math.floor(t.getTime() / BUCKET_MS) * BUCKET_MS);

/** Midnight UTC of `t`'s day. */
const utcMidnight = (t: Date): Date =>
  new Date(Math.floor(t.getTime() / DAY_MS) * DAY_MS);

/** Runs one rollup (see the module comment). */
export async function runFarmRollup(
  db: FarmRollupClient,
  {
    mode = { kind: 'incremental' },
    now = new Date(),
    timeoutMs = FARM_ROLLUP_TIMEOUT_MS,
  }: FarmRollupOptions = {},
): Promise<FarmRollupResult> {
  return db.$transaction(
    async (tx) => {
      const [{ locked, started }] = await tx.$queryRaw<
        { locked: boolean; started: Date }[]
      >`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${FARM_ROLLUP_LOCK}, 0)) AS locked,
               clock_timestamp() AS started`;

      // The newest reading (one index lookup per farm), so a dataset that ends in the past (the
      // CSV fixture) keeps its history; never later than now (a reading may be up to 5 min ahead).
      const [{ newest }] = await tx.$queryRaw<{ newest: Date | null }[]>`
        SELECT max(latest.timestamp) AS newest
        FROM farms f
        CROSS JOIN LATERAL (
          SELECT t.timestamp FROM telemetry t
          WHERE t.farm_id = f.id
          ORDER BY t.timestamp DESC
          LIMIT 1
        ) latest`;
      const anchor = newest && newest < now ? newest : now;
      const cutoff = floorToBucket(
        new Date(anchor.getTime() - FARM_ROLLUP_RETENTION_DAYS * DAY_MS),
      );
      const skipped: FarmRollupResult = {
        skipped: true,
        firstRun: false,
        farms: 0,
        from: null,
        written: 0,
        deleted: 0,
        pruned: 0,
        dirty: 0,
        cutoff: cutoff.toISOString(),
        watermark: null,
      };
      if (!locked) return skipped;

      const state = await tx.farmRollupState.findUnique({ where: { id: 1 } });
      const firstRun = !state;
      const farms = await tx.farm.findMany({ select: { id: true } });

      // Earliest time to recompute, per farm.
      const targets = new Map<string, Date>();
      const add = (farmId: string, from: Date) => {
        const current = targets.get(farmId);
        if (!current || from < current) targets.set(farmId, from);
      };
      const everyFarm = (from: Date) => farms.forEach((f) => add(f.id, from));

      const dirty = await tx.$queryRaw<{ farm_id: string; from_time: Date }[]>`
        DELETE FROM farm_rollup_dirty RETURNING farm_id, from_time`;
      for (const d of dirty) add(d.farm_id, d.from_time);

      if (!state || mode.kind === 'full') {
        everyFarm(cutoff);
      } else {
        const since = new Date(
          state.watermark.getTime() - FARM_ROLLUP_LOOKBACK_MS,
        );
        const created = await tx.$queryRaw<{ farm_id: string; first: Date }[]>`
          SELECT farm_id, min(timestamp) AS first
          FROM telemetry
          WHERE created_at > ${since} AND timestamp >= ${cutoff}
          GROUP BY farm_id`;
        for (const c of created) add(c.farm_id, c.first);
        everyFarm(utcMidnight(now));
        if (mode.kind === 'from') {
          everyFarm(new Date(`${mode.day}T00:00:00.000Z`));
        }
      }

      const entries = [...targets].map(([farmId, from]) => {
        const bucket = floorToBucket(from);
        return { farmId, from: bucket < cutoff ? cutoff : bucket };
      });
      let deleted = 0;
      let written = 0;
      // One farm per statement, so a --full run over months of a large fleet never materialises
      // more than one farm's readings at a time.
      for (const { farmId, from } of entries) {
        deleted += await tx.$executeRaw`
          DELETE FROM farm_telemetry_rollups
          WHERE farm_id = ${farmId} AND bucket_start >= ${from}`;
        written += await tx.$executeRaw`
          WITH raw AS MATERIALIZED (
            SELECT t.turbine_id, t.timestamp,
                   date_bin('30 minutes', t.timestamp, TIMESTAMPTZ '2000-01-01 00:00:00+00') AS bucket,
                   ${RAW_COLUMNS}
            FROM telemetry t
            WHERE t.farm_id = ${farmId} AND t.timestamp >= ${from}
          ),
          series AS (
            SELECT bucket, timestamp, ${SERIES_COLUMNS}
            FROM raw
            GROUP BY bucket, timestamp
          ),
          ohlc AS (
            SELECT bucket, ${OHLC_COLUMNS}
            FROM series
            GROUP BY bucket
          ),
          counts AS (
            SELECT bucket,
                   count(*)::int AS readings,
                   count(DISTINCT turbine_id)::int AS turbines
            FROM raw
            GROUP BY bucket
          )
          INSERT INTO farm_telemetry_rollups
            (farm_id, bucket_start, readings, turbines, ${INSERT_COLUMNS}, computed_at)
          SELECT ${farmId}, o.bucket, c.readings, c.turbines, ${INSERT_COLUMNS}, ${started}
          FROM ohlc o
          JOIN counts c USING (bucket)`;
      }

      const pruned = await tx.$executeRaw`
        DELETE FROM farm_telemetry_rollups WHERE bucket_start < ${cutoff}`;

      await tx.farmRollupState.upsert({
        where: { id: 1 },
        create: { id: 1, watermark: started, updatedAt: started },
        update: { watermark: started, updatedAt: started },
      });

      const earliest = entries.reduce<Date | null>(
        (min, e) => (!min || e.from < min ? e.from : min),
        null,
      );
      return {
        skipped: false,
        firstRun,
        farms: entries.length,
        from: earliest?.toISOString() ?? null,
        written,
        deleted,
        pruned,
        dirty: dirty.length,
        cutoff: cutoff.toISOString(),
        watermark: started.toISOString(),
      };
    },
    { timeout: timeoutMs, maxWait: 10_000 },
  );
}

const RAW_COLUMNS = Prisma.raw(METRICS.map((m) => `t.${m.column}`).join(', '));
const SERIES_COLUMNS = Prisma.raw(
  METRICS.map((m) => `${m.combine}(${m.column}) AS ${m.prefix}`).join(', '),
);
const OHLC_COLUMNS = Prisma.raw(
  METRICS.map(({ prefix: p }) =>
    [
      `(array_agg(${p} ORDER BY timestamp))[1] AS ${p}_open`,
      `(array_agg(${p} ORDER BY timestamp DESC))[1] AS ${p}_close`,
      `max(${p}) AS ${p}_high`,
      `min(${p}) AS ${p}_low`,
    ].join(', '),
  ).join(',\n'),
);
const INSERT_COLUMNS = Prisma.raw(
  METRICS.map(({ prefix: p }) =>
    ['open', 'close', 'high', 'low'].map((s) => `${p}_${s}`).join(', '),
  ).join(', '),
);
