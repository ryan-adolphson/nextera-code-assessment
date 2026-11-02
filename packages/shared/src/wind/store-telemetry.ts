import type {
  AlertConfig,
  Prisma,
  Telemetry,
} from '../generated/prisma/client.js';
import { triggeredAlerts } from './evaluate-alerts.js';
import type { TelemetryWithAlerts } from './responses.js';

/**
 * The rules ingestion evaluates: the enabled ones. Read once per message, upload or seed run,
 * inside the write transaction where there is one.
 */
export function enabledAlertRules(
  tx: Prisma.TransactionClient,
): Promise<AlertConfig[]> {
  return tx.alertConfig.findMany({ where: { enabled: true } });
}

/**
 * Inserts readings, skipping the ones already stored (same turbine + timestamp: ON CONFLICT DO
 * NOTHING), and stores the alert rules each NEW reading triggers (telemetry_alerts). Run it inside
 * a transaction so a reading and its alerts commit together. Returns the new readings with their
 * alerts (worst first), e.g. for the SSE event, without re-reading them.
 */
export async function insertTelemetryWithAlerts(
  tx: Prisma.TransactionClient,
  data: Prisma.TelemetryCreateManyInput[],
  rules: readonly AlertConfig[],
): Promise<TelemetryWithAlerts[]> {
  const readings = await tx.telemetry.createManyAndReturn({
    data,
    skipDuplicates: true,
  });
  return storeAlerts(tx, readings, rules);
}

/**
 * Evaluates new readings against `rules`, stores one telemetry_alerts row per triggered rule, and
 * returns the readings with their alerts (worst first).
 */
export async function storeAlerts(
  tx: Prisma.TransactionClient,
  readings: Telemetry[],
  rules: readonly AlertConfig[],
): Promise<TelemetryWithAlerts[]> {
  const withAlerts = readings.map((reading) => ({
    ...reading,
    alerts: triggeredAlerts(reading, rules).map((alert) => ({ alert })),
  }));
  const links = withAlerts.flatMap((reading) =>
    reading.alerts.map(({ alert }) => ({
      telemetryId: reading.id,
      alertId: alert.id,
    })),
  );
  if (links.length) await tx.telemetryAlert.createMany({ data: links });
  return withAlerts;
}

/** One reading for `insertTelemetryBulk`: every column given (no defaults). */
export interface BulkTelemetryRow {
  turbineId: string;
  farmId: string;
  timestamp: Date;
  receivedAt: Date;
  powerOutputKw: number;
  windSpeedMs: number;
  rotorRpm: number;
  bladePitchDeg: number;
  gearboxTempC: number;
}

/**
 * Bulk insert for large backfills (the demo seed: up to ~400k readings), same result as
 * `insertTelemetryWithAlerts`: duplicates (same turbine + timestamp) are skipped and every NEW
 * reading's triggered rules are stored in telemetry_alerts. Readings that trigger an enabled rule
 * (`triggeredAlerts`, the same evaluation) go through `insertTelemetryWithAlerts`; the rest, nearly
 * all of them, through one `INSERT … SELECT FROM unnest(<one array per column>) ON CONFLICT DO
 * NOTHING`, which is ~4× faster than Prisma's createMany (whose per-row cost is in JS) and has no
 * bind-parameter limit. Run it inside a transaction. Returns the counts only (no rows).
 */
export async function insertTelemetryBulk(
  tx: Prisma.TransactionClient,
  rows: readonly BulkTelemetryRow[],
  rules: readonly AlertConfig[],
): Promise<{ inserted: number; alerts: number }> {
  const quiet: BulkTelemetryRow[] = [];
  const flagged: BulkTelemetryRow[] = [];
  for (const row of rows) {
    (triggeredAlerts(row, rules).length ? flagged : quiet).push(row);
  }
  let inserted = 0;
  if (quiet.length) {
    const col = <T>(pick: (r: BulkTelemetryRow) => T) => quiet.map(pick);
    const [{ count }] = await tx.$queryRaw<{ count: number }[]>`
      WITH inserted AS (
        INSERT INTO telemetry (turbine_id, farm_id, "timestamp", received_at, power_output_kw,
                               wind_speed_ms, rotor_rpm, blade_pitch_deg, gearbox_temp_c)
        SELECT * FROM unnest(
          ${col((r) => r.turbineId)}::text[],
          ${col((r) => r.farmId)}::text[],
          ${col((r) => r.timestamp.toISOString())}::timestamptz[],
          ${col((r) => r.receivedAt.toISOString())}::timestamptz[],
          ${col((r) => r.powerOutputKw)}::float8[],
          ${col((r) => r.windSpeedMs)}::float8[],
          ${col((r) => r.rotorRpm)}::float8[],
          ${col((r) => r.bladePitchDeg)}::float8[],
          ${col((r) => r.gearboxTempC)}::float8[])
        ON CONFLICT DO NOTHING
        RETURNING 1)
      SELECT count(*)::int AS count FROM inserted`;
    inserted += count;
  }
  let alerts = 0;
  if (flagged.length) {
    const stored = await insertTelemetryWithAlerts(tx, flagged, rules);
    inserted += stored.length;
    alerts = stored.reduce((n, r) => n + r.alerts.length, 0);
  }
  return { inserted, alerts };
}
