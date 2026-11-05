import { Prisma } from '../generated/prisma/client.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import {
  ANOMALY_STEP_MINUTES,
  EXPECTED_POWER_MIN_BIN_READINGS,
} from './anomalies.js';
import { anomalyEpisodesSql } from './anomaly-sql.js';

/**
 * The anomaly rollup: `anomaly_episodes`, computed from the stored readings by the same SQL as
 * `listAnomalies` (`anomalyEpisodesSql`, so the same thresholds and gaps-and-islands rules), but
 * hourly and incrementally instead of on every read. Run by `node dist/anomaly-rollup/main.js`
 * (Cloud Run Job hourly, compose `anomaly-rollup`) and `npm run anomalies:rollup`.
 *
 * One run is one transaction (a failed run changes nothing, the state included):
 *   1. `pg_try_advisory_xact_lock`: another run in progress → skipped.
 *   2. Calibration: `anomaly_expected_power` is rewritten from the fleet's last
 *      ANOMALY_CALIBRATION_HOURS: the median power per 1 m/s wind bin, over a sample of
 *      ~ANOMALY_CALIBRATION_TURBINES turbines on larger fleets (every turbine up to that size, so
 *      the demo's figures equal listAnomalies').
 *   3. Window: from L = (previous run's end) - ANOMALY_LOOKBACK_MINUTES (or `--from`, or
 *      ANOMALY_BACKFILL_DAYS back on the first run) to `now`. Episodes still open at L (ending
 *      within a step of it) are deleted and recomputed from their own start, so a long stuck
 *      sensor stays ONE episode across runs; episodes that ended earlier are untouched. Turbines
 *      are processed in chunks of ANOMALY_CHUNK_TURBINES (the rules are per turbine).
 *   4. Prunes episodes that ended more than ANOMALY_EPISODE_RETENTION_DAYS before `now`.
 *
 * Limits: a reading that arrives more than the lookback after its timestamp is not seen (the
 * window starts after it); `--from` recomputes older ranges. Episodes are whole episodes, not
 * clipped to a query range (unlike listAnomalies' result).
 */

/** Calibration window: expected power is the median of this many hours of readings. */
export const ANOMALY_CALIBRATION_HOURS = 24;
/** The calibration reads at most about this many turbines (a hash sample above that). */
export const ANOMALY_CALIBRATION_TURBINES = 10_000;
/** Each run recomputes this far before the previous run's end (covers late readings). */
export const ANOMALY_LOOKBACK_MINUTES = 120;
/** The first run looks this far back. */
export const ANOMALY_BACKFILL_DAYS = 7;
/** Turbines per SQL statement. */
export const ANOMALY_CHUNK_TURBINES = 20_000;
/** Episodes that ended longer ago than this are deleted (the API's widest range is 31 days). */
export const ANOMALY_EPISODE_RETENTION_DAYS = 62;
/** Key of the advisory lock that keeps runs from overlapping. */
export const ANOMALY_ROLLUP_LOCK = 'anomaly-rollup';
export const ANOMALY_ROLLUP_TIMEOUT_MS = 30 * 60_000;

const DAY_MS = 24 * 60 * 60_000;
const MINUTE_MS = 60_000;
const MAX_CATCH_UP_MS = 31 * DAY_MS;

export type AnomalyRollupMode =
  | { kind: 'incremental' }
  /** Recompute every turbine from this UTC day (YYYY-MM-DD) on. */
  | { kind: 'from'; day: string };

export interface AnomalyRollupOptions {
  mode?: AnomalyRollupMode;
  /** The window's end and the calibration's end (default now). */
  now?: Date;
  /** Override ANOMALY_CALIBRATION_HOURS. */
  calibrationHours?: number;
  lookbackMinutes?: number;
  chunkTurbines?: number;
  timeoutMs?: number;
}

export interface AnomalyRollupResult {
  skipped: boolean;
  /** The window start (ISO) and end. Null when skipped. */
  from: string | null;
  asOf: string | null;
  /** Wind bins stored by the calibration, and the divisor of the turbine sample (1 = all). */
  bins: number;
  sampleDivisor: number;
  /** Open episodes that were recomputed from their own start. */
  reopened: number;
  /** Episodes deleted for the recompute, written, and pruned as old. */
  deleted: number;
  written: number;
  pruned: number;
  chunks: number;
}

export type AnomalyRollupClient = Pick<PrismaClient, '$transaction'>;

/** Runs one rollup (see the module comment). */
export async function runAnomalyRollup(
  db: AnomalyRollupClient,
  {
    mode = { kind: 'incremental' },
    now = new Date(),
    calibrationHours = ANOMALY_CALIBRATION_HOURS,
    lookbackMinutes = ANOMALY_LOOKBACK_MINUTES,
    chunkTurbines = ANOMALY_CHUNK_TURBINES,
    timeoutMs = ANOMALY_ROLLUP_TIMEOUT_MS,
  }: AnomalyRollupOptions = {},
): Promise<AnomalyRollupResult> {
  return db.$transaction(
    async (tx) => {
      const [{ locked, started }] = await tx.$queryRaw<
        { locked: boolean; started: Date }[]
      >`
        SELECT pg_try_advisory_xact_lock(hashtextextended(${ANOMALY_ROLLUP_LOCK}, 0)) AS locked,
               clock_timestamp() AS started`;
      const skipped: AnomalyRollupResult = {
        skipped: true,
        from: null,
        asOf: null,
        bins: 0,
        sampleDivisor: 1,
        reopened: 0,
        deleted: 0,
        written: 0,
        pruned: 0,
        chunks: 0,
      };
      if (!locked) return skipped;

      // 2. Calibration.
      const [{ turbines: fleetSize }] = await tx.$queryRaw<
        { turbines: number }[]
      >`
        SELECT count(*)::int AS turbines FROM turbine_latest`;
      const sampleDivisor = Math.max(
        1,
        Math.ceil(fleetSize / ANOMALY_CALIBRATION_TURBINES),
      );
      const calibrationFrom = new Date(
        now.getTime() - calibrationHours * 60 * MINUTE_MS,
      );
      await tx.$executeRaw`DELETE FROM anomaly_expected_power`;
      const bins = await tx.$executeRaw`
        INSERT INTO anomaly_expected_power (wind_bin, expected_kw, readings, computed_at)
        SELECT floor(t.wind_speed_ms)::int, percentile_cont(0.5) WITHIN GROUP (ORDER BY t.power_output_kw),
               count(*)::int, ${started}
        FROM telemetry t
        WHERE t."timestamp" >= ${calibrationFrom} AND t."timestamp" < ${now}
          AND (${sampleDivisor}::int = 1
               OR mod(abs(hashtextextended(t.turbine_id, 0)), ${sampleDivisor}::bigint) = 0)
        GROUP BY 1
        HAVING count(*) >= ${EXPECTED_POWER_MIN_BIN_READINGS}::int`;

      // 3. Window start.
      const state = await tx.anomalyRollupState.findUnique({
        where: { id: 1 },
      });
      let from: Date;
      if (mode.kind === 'from') {
        from = new Date(`${mode.day}T00:00:00.000Z`);
      } else if (
        state &&
        now.getTime() - state.asOf.getTime() <= MAX_CATCH_UP_MS
      ) {
        from = new Date(state.asOf.getTime() - lookbackMinutes * MINUTE_MS);
      } else {
        // First run, or the last one is older than a month (the API's widest range): start over
        // from the backfill window rather than scanning months in one go (`--from` goes further).
        from = new Date(now.getTime() - ANOMALY_BACKFILL_DAYS * DAY_MS);
      }
      if (from >= now)
        from = new Date(now.getTime() - lookbackMinutes * MINUTE_MS);

      // Episodes still open at `from` (they end within a step of it) restart at their own start.
      const edge = new Date(from.getTime() - ANOMALY_STEP_MINUTES * MINUTE_MS);
      const open = await tx.$queryRaw<{ turbine_id: string; since: Date }[]>`
        SELECT turbine_id, min(episode_start) AS since
        FROM anomaly_episodes
        WHERE episode_end >= ${edge} AND episode_start < ${from}
        GROUP BY turbine_id`;
      const openIds = open.map((o) => o.turbine_id);
      const openSince = open.map((o) => o.since.toISOString());
      const earliest = open.reduce(
        (min, o) => (o.since < min ? o.since : min),
        from,
      );

      const deleted = await tx.$executeRaw`
        DELETE FROM anomaly_episodes WHERE episode_end >= ${edge}`;

      // Chunks of turbine ids, in the database's own order (so ranges are consistent with the
      // (turbine_id, timestamp) index the range filters use).
      const ranges = await tx.$queryRaw<{ lo: string; hi: string }[]>`
        SELECT min(turbine_id) AS lo, max(turbine_id) AS hi
        FROM (
          SELECT turbine_id, (row_number() OVER (ORDER BY turbine_id) - 1) / ${chunkTurbines}::int AS grp
          FROM turbines
        ) numbered
        GROUP BY grp
        ORDER BY lo`;

      let written = 0;
      for (const { lo, hi } of ranges) {
        const episodes = anomalyEpisodesSql({
          readings: Prisma.sql`
            SELECT t.turbine_id, t.farm_id, t.timestamp,
                   t.power_output_kw AS p, t.wind_speed_ms AS w, t.rotor_rpm AS rpm,
                   t.gearbox_temp_c AS g, floor(t.wind_speed_ms)::int AS bin
            FROM telemetry t
            LEFT JOIN unnest(${openIds}::text[], ${openSince}::timestamptz[]) AS o(turbine_id, since)
              ON o.turbine_id = t.turbine_id
            WHERE t.timestamp >= ${earliest} AND t.timestamp < ${now}
              AND t.timestamp >= coalesce(o.since, ${from}::timestamptz)
              AND t.turbine_id >= ${lo} AND t.turbine_id <= ${hi}`,
          bins: Prisma.sql`
            SELECT wind_bin AS bin, expected_kw AS expected FROM anomaly_expected_power`,
        });
        written += await tx.$executeRaw`
          INSERT INTO anomaly_episodes (kind, metric, turbine_id, farm_id, episode_start,
                                        episode_end, readings, value, wind_speed_ms, lost_kwh,
                                        computed_at)
          SELECT e.kind, e.metric, e.turbine_id, e.farm_id, e.episode_start, e.episode_end,
                 e.readings, e.value, e.wind_speed_ms, e.lost_kwh, ${started}
          FROM (${episodes}) e`;
      }

      // 4. Retention, and the state.
      const pruned = await tx.$executeRaw`
        DELETE FROM anomaly_episodes
        WHERE episode_end < ${new Date(now.getTime() - ANOMALY_EPISODE_RETENTION_DAYS * DAY_MS)}`;
      await tx.anomalyRollupState.upsert({
        where: { id: 1 },
        create: { id: 1, asOf: now, updatedAt: started },
        update: { asOf: now, updatedAt: started },
      });

      return {
        skipped: false,
        from: earliest.toISOString(),
        asOf: now.toISOString(),
        bins,
        sampleDivisor,
        reopened: open.length,
        deleted,
        written,
        pruned,
        chunks: ranges.length,
      };
    },
    { timeout: timeoutMs, maxWait: 10_000 },
  );
}
