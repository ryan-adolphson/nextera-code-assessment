import type { PrismaClient } from '../generated/prisma/client.js';

/**
 * farm_live_summary: per-farm live totals rebuilt from turbine_latest. Run every minute by the
 * live-summary job (`node dist/live-summary/main.js`), which then publishes `fleet.tick`.
 */

/** SSE event (global stream): the live summaries were refreshed. Payload `FleetTickEvent`. */
export const FLEET_TICK = 'fleet.tick';

/** Payload of `fleet.tick`. */
export interface FleetTickEvent {
  /** The instant the summaries were computed for (ISO, UTC). */
  asOf: string;
}

/** A turbine whose newest reading is at most this old (at `asOf`) is "reporting". */
export const LIVE_REPORTING_MINUTES = 15;

export interface LiveSummaryResult {
  /** Farm rows written (one per farm). */
  farms: number;
  asOf: string;
}

export type LiveSummaryClient = Pick<PrismaClient, '$executeRaw'>;

/**
 * Rebuilds farm_live_summary for every farm in one statement (two grouped scans: turbines and
 * turbine_latest). `now` is the staleness reference and the rows' `as_of`.
 */
export async function runLiveSummary(
  db: LiveSummaryClient,
  { now = new Date() }: { now?: Date } = {},
): Promise<LiveSummaryResult> {
  const reportingSince = new Date(
    now.getTime() - LIVE_REPORTING_MINUTES * 60_000,
  );
  const farms = await db.$executeRaw`
    WITH fleet AS (
      SELECT farm_id, count(*)::int AS turbines, (count(*) FILTER (WHERE commissioned))::int AS commissioned
      FROM turbines
      GROUP BY farm_id
    ),
    live AS (
      SELECT farm_id,
             (count(*) FILTER (WHERE "timestamp" >= ${reportingSince}))::int AS reporting,
             (count(*) FILTER (WHERE "timestamp" < ${reportingSince}))::int AS stale,
             (count(*) FILTER (WHERE "timestamp" >= ${reportingSince}
                                 AND worst_alert_level IS NOT NULL))::int AS alerting,
             coalesce(sum(power_output_kw) FILTER (WHERE "timestamp" >= ${reportingSince}), 0) AS power,
             avg(wind_speed_ms) FILTER (WHERE "timestamp" >= ${reportingSince}) AS wind
      FROM turbine_latest
      GROUP BY farm_id
    )
    INSERT INTO farm_live_summary (farm_id, turbines, commissioned, reporting, stale, alerting,
                                   power_output_kw, wind_speed_ms, as_of)
    SELECT f.id, coalesce(fl.turbines, 0), coalesce(fl.commissioned, 0),
           coalesce(l.reporting, 0), coalesce(l.stale, 0), coalesce(l.alerting, 0),
           coalesce(l.power, 0), l.wind, ${now}
    FROM farms f
    LEFT JOIN fleet fl ON fl.farm_id = f.id
    LEFT JOIN live l ON l.farm_id = f.id
    ORDER BY f.id
    ON CONFLICT (farm_id) DO UPDATE SET
      turbines = EXCLUDED.turbines,
      commissioned = EXCLUDED.commissioned,
      reporting = EXCLUDED.reporting,
      stale = EXCLUDED.stale,
      alerting = EXCLUDED.alerting,
      power_output_kw = EXCLUDED.power_output_kw,
      wind_speed_ms = EXCLUDED.wind_speed_ms,
      as_of = EXCLUDED.as_of`;
  return { farms, asOf: now.toISOString() };
}
