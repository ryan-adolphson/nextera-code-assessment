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
