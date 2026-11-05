import type {
  AlertConfig,
  Prisma,
  Telemetry,
} from '../generated/prisma/client.js';
import { triggeredAlerts } from './evaluate-alerts.js';
import type { TelemetryWithAlerts } from './responses.js';
import { upsertTurbineLatest, worstAlertLevel } from './turbine-latest.js';

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
 * NOTHING), stores the alert rules each NEW reading triggers (telemetry_alerts) and upserts
 * turbine_latest with each turbine's newest new reading (only if newer than its row). Run it
 * inside a transaction so a reading, its alerts and the latest row commit together. Returns the
 * new readings with their alerts (worst first), e.g. for the SSE event, without re-reading them.
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
  const stored = await storeAlerts(tx, readings, rules);
  await upsertTurbineLatest(
    tx,
    stored.map((reading) => ({
      ...reading,
      worstAlertLevel: worstAlertLevel(reading.alerts),
    })),
  );
  return stored;
}

/**
 * Evaluates new readings against `rules`, stores one telemetry_alerts row per triggered rule, and
 * returns the readings with their alerts (worst first). Does not touch turbine_latest: use
 * `insertTelemetryWithAlerts`, which does.
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
      readingTimestamp: reading.timestamp,
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
 * bind-parameter limit. Both paths upsert turbine_latest. Run it inside a transaction. Returns the
 * counts only (no rows).
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
    const stored = await tx.$queryRaw<
      {
        id: string;
        turbine_id: string;
        farm_id: string;
        timestamp: Date;
        received_at: Date;
        power_output_kw: number;
        wind_speed_ms: number;
        rotor_rpm: number;
        blade_pitch_deg: number;
        gearbox_temp_c: number;
      }[]
    >`
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
      RETURNING id::text AS id, turbine_id, farm_id, "timestamp", received_at, power_output_kw,
                wind_speed_ms, rotor_rpm, blade_pitch_deg, gearbox_temp_c`;
    inserted += stored.length;
    await upsertTurbineLatest(
      tx,
      stored.map((r) => ({
        id: r.id,
        turbineId: r.turbine_id,
        farmId: r.farm_id,
        timestamp: r.timestamp,
        receivedAt: r.received_at,
        powerOutputKw: r.power_output_kw,
        windSpeedMs: r.wind_speed_ms,
        rotorRpm: r.rotor_rpm,
        bladePitchDeg: r.blade_pitch_deg,
        gearboxTempC: r.gearbox_temp_c,
        worstAlertLevel: null, // quiet readings triggered no rule
      })),
    );
  }
  let alerts = 0;
  if (flagged.length) {
    const stored = await insertTelemetryWithAlerts(tx, flagged, rules);
    inserted += stored.length;
    alerts = stored.reduce((n, r) => n + r.alerts.length, 0);
  }
  return { inserted, alerts };
}
