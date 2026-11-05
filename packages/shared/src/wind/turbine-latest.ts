import { Prisma } from '../generated/prisma/client.js';
import type { AlertLevel } from '../generated/prisma/enums.js';

/**
 * turbine_latest: each turbine's newest reading, kept up to date by whoever stores readings
 * (`insertTelemetryWithAlerts`, so Pub/Sub ingestion, CSV uploads and held-reading imports; the
 * seeds through `refreshTurbineLatest`). One row per turbine; an upsert in the reading's own
 * transaction, only when the reading is NEWER than the row, so a late reading (a backfill, a
 * redelivery of an old one) never overwrites it.
 */

/** Severity order of the levels (the enum's declaration order). */
const LEVEL_RANK: Record<AlertLevel, number> = { info: 0, warn: 1, error: 2 };

/** The most severe level among the rules a reading triggered; null when it triggered none. */
export function worstAlertLevel(
  alerts: readonly { alert: { alertLevel: AlertLevel } }[],
): AlertLevel | null {
  let worst: AlertLevel | null = null;
  for (const { alert } of alerts) {
    if (!worst || LEVEL_RANK[alert.alertLevel] > LEVEL_RANK[worst]) {
      worst = alert.alertLevel;
    }
  }
  return worst;
}

/** What the upsert needs of a stored reading. */
export interface LatestCandidate {
  id: string;
  turbineId: string;
  farmId: string;
  timestamp: Date;
  receivedAt: Date;
  powerOutputKw: number;
  windSpeedMs: number;
  rotorRpm: number;
  bladePitchDeg: number;
  gearboxTempC: number;
  /** Severity of its worst triggered rule; null if none. */
  worstAlertLevel: AlertLevel | null;
}

const CHUNK = 5000;

/** Code-unit order: one order for every writer, which is what keeps row locks deadlock-free. */
const byTurbineId = (a: { turbineId: string }, b: { turbineId: string }) =>
  a.turbineId < b.turbineId ? -1 : a.turbineId > b.turbineId ? 1 : 0;

/**
 * Upserts turbine_latest from stored readings (run it in the transaction that stored them).
 *
 * - Only the newest reading per turbine is written (a single `ON CONFLICT DO UPDATE` statement
 *   can't touch a row twice), and only when it is newer than the row's `timestamp`.
 * - Rows are written in turbine id order, in `COLLATE "C"` too, so two concurrent transactions
 *   that share turbines lock them in the same order and can't deadlock each other.
 * - A turbine that moved carries its new farm_id; the composite foreign key to turbines makes a
 *   write for a stale (turbine, farm) pair fail like the reading's own insert does.
 */
export async function upsertTurbineLatest(
  tx: Prisma.TransactionClient,
  readings: readonly LatestCandidate[],
): Promise<void> {
  const newest = new Map<string, LatestCandidate>();
  for (const reading of readings) {
    const current = newest.get(reading.turbineId);
    if (!current || reading.timestamp > current.timestamp) {
      newest.set(reading.turbineId, reading);
    }
  }
  const rows = [...newest.values()].sort(byTurbineId);

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const col = <T>(pick: (r: LatestCandidate) => T) => chunk.map(pick);
    await tx.$executeRaw`
      INSERT INTO turbine_latest (turbine_id, farm_id, reading_id, "timestamp", received_at,
                                  power_output_kw, wind_speed_ms, rotor_rpm, blade_pitch_deg,
                                  gearbox_temp_c, worst_alert_level)
      SELECT u.turbine_id, u.farm_id, u.reading_id, u.ts, u.received_at, u.p, u.w, u.rpm, u.pitch,
             u.g, u.level::alert_level
      FROM unnest(
        ${col((r) => r.turbineId)}::text[],
        ${col((r) => r.farmId)}::text[],
        ${col((r) => r.id)}::uuid[],
        ${col((r) => r.timestamp.toISOString())}::timestamptz[],
        ${col((r) => r.receivedAt.toISOString())}::timestamptz[],
        ${col((r) => r.powerOutputKw)}::float8[],
        ${col((r) => r.windSpeedMs)}::float8[],
        ${col((r) => r.rotorRpm)}::float8[],
        ${col((r) => r.bladePitchDeg)}::float8[],
        ${col((r) => r.gearboxTempC)}::float8[],
        ${col((r) => r.worstAlertLevel)}::text[]
      ) AS u(turbine_id, farm_id, reading_id, ts, received_at, p, w, rpm, pitch, g, level)
      ORDER BY u.turbine_id COLLATE "C"
      ON CONFLICT (turbine_id) DO UPDATE SET
        farm_id = EXCLUDED.farm_id,
        reading_id = EXCLUDED.reading_id,
        "timestamp" = EXCLUDED."timestamp",
        received_at = EXCLUDED.received_at,
        power_output_kw = EXCLUDED.power_output_kw,
        wind_speed_ms = EXCLUDED.wind_speed_ms,
        rotor_rpm = EXCLUDED.rotor_rpm,
        blade_pitch_deg = EXCLUDED.blade_pitch_deg,
        gearbox_temp_c = EXCLUDED.gearbox_temp_c,
        worst_alert_level = EXCLUDED.worst_alert_level
      WHERE turbine_latest."timestamp" < EXCLUDED."timestamp"`;
  }
}

/**
 * Brings turbine_latest in line with telemetry for `turbineIds` (default: every turbine that has a
 * reading), from the stored readings and their alerts: set-based, newest reading per turbine, and
 * still only when newer than the row. For the seeds and repairs; ingestion upserts as it stores.
 * Returns the number of rows written.
 */
export async function refreshTurbineLatest(
  tx: Prisma.TransactionClient,
  turbineIds?: readonly string[],
): Promise<number> {
  const only = turbineIds
    ? Prisma.sql`WHERE t.turbine_id = ANY(${[...turbineIds]}::text[])`
    : Prisma.sql``;
  return tx.$executeRaw`
    INSERT INTO turbine_latest (turbine_id, farm_id, reading_id, "timestamp", received_at,
                                power_output_kw, wind_speed_ms, rotor_rpm, blade_pitch_deg,
                                gearbox_temp_c, worst_alert_level)
    SELECT DISTINCT ON (t.turbine_id COLLATE "C")
           t.turbine_id, t.farm_id, t.id, t."timestamp", t.received_at, t.power_output_kw,
           t.wind_speed_ms, t.rotor_rpm, t.blade_pitch_deg, t.gearbox_temp_c,
           (SELECT max(c.alert_level)
            FROM telemetry_alerts a
            JOIN alerts_config c ON c.id = a.alert_id
            WHERE a.telemetry_id = t.id AND a.reading_timestamp = t."timestamp")
    FROM telemetry t
    ${only}
    ORDER BY t.turbine_id COLLATE "C", t."timestamp" DESC
    ON CONFLICT (turbine_id) DO UPDATE SET
      farm_id = EXCLUDED.farm_id,
      reading_id = EXCLUDED.reading_id,
      "timestamp" = EXCLUDED."timestamp",
      received_at = EXCLUDED.received_at,
      power_output_kw = EXCLUDED.power_output_kw,
      wind_speed_ms = EXCLUDED.wind_speed_ms,
      rotor_rpm = EXCLUDED.rotor_rpm,
      blade_pitch_deg = EXCLUDED.blade_pitch_deg,
      gearbox_temp_c = EXCLUDED.gearbox_temp_c,
      worst_alert_level = EXCLUDED.worst_alert_level
    WHERE turbine_latest."timestamp" < EXCLUDED."timestamp"`;
}
