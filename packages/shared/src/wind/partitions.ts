import type { PrismaClient } from '../generated/prisma/client.js';

/**
 * Partition maintenance for telemetry and telemetry_alerts (daily range partitions on the
 * measurement timestamp, plus a DEFAULT partition for everything outside them). The DDL lives in
 * SQL functions created by the migration 20261104120000_scale_partitions_latest:
 *
 * - `telemetry_ensure_partition(day)`: creates the day's partitions for both tables, first moving
 *   the day's rows (with their alerts) out of the DEFAULT partitions, because Postgres refuses to
 *   create a partition while the DEFAULT one holds rows of its range. Seed fixtures, CSV
 *   backfills and anything written before a partition existed land in DEFAULT.
 * - `telemetry_drop_partitions_before(day)`: drops whole days (readings and alerts together).
 *
 * `runPartitionMaintenance` is what the daily job (`node dist/partition-maintenance/main.js`) runs.
 */

/** Partitions are created this many days beyond today. */
export const PARTITION_DAYS_AHEAD = 3;
/** Rows in the DEFAULT partition from this many days back are moved into daily partitions. */
export const PARTITION_CARVE_DAYS = 31;
/** Retention deletes the DEFAULT partition in chunks of this many rows. */
export const PURGE_CHUNK = 20_000;
const LOCK_RETRIES = 3;
const DAY_MS = 24 * 60 * 60_000;

export interface PartitionMaintenanceOptions {
  /** Days of raw readings to keep. Undefined/null: no retention (nothing is dropped or purged). */
  retentionDays?: number | null;
  /** The clock (default now). */
  now?: Date;
  daysAhead?: number;
}

export interface PartitionMaintenanceResult {
  /** UTC days whose partitions were created (YYYY-MM-DD). */
  created: string[];
  /** Daily partitions dropped (a day = readings + alerts partition). */
  dropped: number;
  /** Rows deleted from the DEFAULT partition (older than the retention). */
  purgedDefault: number;
  /** Readings older than this are deleted: whole days for partitions, exact for DEFAULT. Null: no retention. */
  retentionCutoff: string | null;
  /** True when another maintenance run held the lock: this run did nothing. */
  skipped: boolean;
}

/** The client the maintenance needs. */
export type PartitionClient = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

/** The client `runPartitionMaintenance` needs: it also pins one connection for the run lock. */
export type MaintenanceClient = PartitionClient &
  Pick<PrismaClient, '$transaction'>;

/**
 * Run lock key. Not 'telemetry-partitions': the SQL functions take that xact lock on their own
 * connection, and the run lock is held on another one, so sharing it would block the run forever.
 */
export const PARTITION_MAINTENANCE_LOCK = 'partition-maintenance';
/** The run holds its lock for as long as it works (one transaction pins the connection). */
const RUN_LOCK_TIMEOUT_MS = 2 * 60 * 60_000;

const utcDay = (t: Date): string => t.toISOString().slice(0, 10);
const addDays = (day: string, n: number): string =>
  utcDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS));

/** Postgres `lock_not_available` (55P03: lock_timeout expired): a writer held the table too long. */
function isLockTimeout(error: unknown): boolean {
  interface Chained {
    message?: unknown;
    code?: unknown;
    meta?: unknown;
    cause?: unknown;
  }
  let text = '';
  let current = error as Chained | undefined;
  for (let depth = 0; current && depth < 5; depth++) {
    text += ` ${String(current.message)} ${String(current.code)} ${JSON.stringify(current.meta ?? '')}`;
    current = current.cause as Chained | undefined;
  }
  return /55P03|lock timeout/i.test(text);
}

async function withLockRetry<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= LOCK_RETRIES || !isLockTimeout(error)) throw error;
    }
  }
}

/** Creates the partitions of `day` (YYYY-MM-DD); false if they already existed. */
export async function ensureTelemetryPartition(
  db: PartitionClient,
  day: string,
): Promise<boolean> {
  const [{ created }] = await withLockRetry(
    () => db.$queryRaw<{ created: boolean }[]>`
      SELECT telemetry_ensure_partition(${day}::date) AS created`,
  );
  return created;
}

/**
 * Creates the partitions of every UTC day from `from` to `to` that lacks one (a seed that is about
 * to write a window of days calls it first, so its rows go straight into daily partitions instead
 * of DEFAULT). Returns the days created.
 */
export async function ensureTelemetryPartitions(
  db: PartitionClient,
  from: Date,
  to: Date,
): Promise<string[]> {
  const created: string[] = [];
  for (let day = utcDay(from); day <= utcDay(to); day = addDays(day, 1)) {
    if (await ensureTelemetryPartition(db, day)) created.push(day);
  }
  return created;
}

/** The days (YYYY-MM-DD) that have rows in the DEFAULT partition from `since` on. */
async function defaultDays(
  db: PartitionClient,
  since: Date,
  until: Date,
): Promise<string[]> {
  const rows = await db.$queryRaw<{ day: string }[]>`
    SELECT DISTINCT to_char("timestamp" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day
    FROM telemetry_default
    WHERE "timestamp" >= ${since} AND "timestamp" < ${until}
    ORDER BY 1`;
  return rows.map((r) => r.day);
}

/**
 * One maintenance run:
 *   1. creates the partitions of today and the next `daysAhead` days;
 *   2. moves the DEFAULT partition's rows of the last PARTITION_CARVE_DAYS (or the retention, if
 *      longer) into daily partitions, so queries over recent days prune to them;
 *   3. only with a retention: drops the daily partitions that end before `now - retention`, and
 *      deletes the DEFAULT partition's older rows. Without a retention nothing is ever deleted, so
 *      a local database keeps its fixtures (the CSV seed's January 2026 readings stay in DEFAULT).
 * Safe to repeat. Each statement is its own transaction; a lock timeout is retried.
 */
export async function runPartitionMaintenance(
  db: MaintenanceClient,
  options: PartitionMaintenanceOptions = {},
): Promise<PartitionMaintenanceResult> {
  if (options.retentionDays != null && !(options.retentionDays >= 1)) {
    throw new Error('retentionDays must be at least 1');
  }
  // Each statement of the run is its own transaction (a lock timeout retries one statement, not
  // the run), so the run lock can't be an xact lock of those. Instead one interactive transaction
  // holds `pg_try_advisory_xact_lock` on a pinned pooled connection while the work runs on the
  // others (the pool needs 2). Postgres releases it at commit/rollback or if the connection dies,
  // so a failed run can't leave it behind (a session lock would stay on the pooled connection).
  // The SQL functions are already safe when runs overlap (they serialize on their own lock and
  // re-check existence); this lock makes the overlapping run skip instead of waiting and repeating.
  return db.$transaction(
    async (lockTx) => {
      const [{ locked }] = await lockTx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${PARTITION_MAINTENANCE_LOCK}, 0)) AS locked`;
      if (!locked) {
        return {
          created: [],
          dropped: 0,
          purgedDefault: 0,
          retentionCutoff: null,
          skipped: true,
        };
      }
      return maintain(db, options);
    },
    { timeout: RUN_LOCK_TIMEOUT_MS, maxWait: 30_000 },
  );
}

async function maintain(
  db: PartitionClient,
  {
    retentionDays,
    now = new Date(),
    daysAhead = PARTITION_DAYS_AHEAD,
  }: PartitionMaintenanceOptions,
): Promise<PartitionMaintenanceResult> {
  const today = utcDay(now);
  const retentionCutoff =
    retentionDays != null
      ? new Date(now.getTime() - retentionDays * DAY_MS)
      : null;

  const wanted = new Set<string>();
  for (let i = 0; i <= daysAhead; i++) wanted.add(addDays(today, i));
  const carveSince = new Date(
    now.getTime() - Math.max(retentionDays ?? 0, PARTITION_CARVE_DAYS) * DAY_MS,
  );
  const carveUntil = new Date(
    Date.parse(`${addDays(today, daysAhead + 1)}T00:00:00Z`),
  );
  for (const day of await defaultDays(db, carveSince, carveUntil))
    wanted.add(day);

  const created: string[] = [];
  for (const day of [...wanted].sort()) {
    if (retentionCutoff && day < utcDay(retentionCutoff)) continue; // about to be dropped anyway
    if (await ensureTelemetryPartition(db, day)) created.push(day);
  }

  let dropped = 0;
  let purgedDefault = 0;
  if (retentionCutoff) {
    const cutoffDay = utcDay(retentionCutoff);
    const [row] = await withLockRetry(
      () => db.$queryRaw<{ dropped: number }[]>`
        SELECT telemetry_drop_partitions_before(${cutoffDay}::date) AS dropped`,
    );
    dropped = row.dropped;

    for (;;) {
      // Deleting a reading cascades to its alerts (the DEFAULT partition of telemetry_alerts).
      const n = await db.$executeRaw`
        DELETE FROM telemetry_default
        WHERE ctid = ANY (ARRAY(
          SELECT ctid FROM telemetry_default WHERE "timestamp" < ${retentionCutoff} LIMIT ${PURGE_CHUNK}))`;
      purgedDefault += n;
      if (n < PURGE_CHUNK) break;
    }
  }

  return {
    created,
    dropped,
    purgedDefault,
    retentionCutoff: retentionCutoff?.toISOString() ?? null,
    skipped: false,
  };
}
