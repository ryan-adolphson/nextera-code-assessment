import type { PrismaClient } from '../generated/prisma/client.js';
import {
  enabledAlertRules,
  insertTelemetryWithAlerts,
} from '../wind/store-telemetry.js';
import { DEMO_ALERT_RULES, DEMO_SEED, DEMO_TURBINES } from './demo-fleet.js';
import {
  floorToTelemetryStep,
  generateTelemetry,
  type GeneratedTelemetryRow,
} from './generate-telemetry.js';
import { seedFarmsFromCsv } from './seed-from-csv.js';

/** Default window of the demo seed (SEED_HOURS overrides it, up to DEMO_SEED_MAX_HOURS). */
export const DEMO_SEED_HOURS = 72;
export const DEMO_SEED_MAX_HOURS = 31 * 24;
const BATCH_SIZE = 1000;

export interface DemoSeedOptions {
  /** Directory of the fixture farms.csv (prisma/data). */
  dataDir: string;
  /** Newest measurement time (floored to 5 minutes). */
  end: Date;
  hours: number;
}

export interface DemoSeedResult {
  farms: number;
  turbines: number;
  /** Default rules created by this run (existing ones are kept as they are). */
  rulesCreated: number;
  /** Enabled rules the readings were evaluated against. */
  rulesEvaluated: number;
  rows: number;
  inserted: number;
  /** Rows already stored (same turbine + timestamp). */
  skipped: number;
  /** telemetry_alerts rows written for the new readings. */
  alerts: number;
  from: string | null;
  to: string | null;
}

/** SEED_NOW (strict ISO 8601 with a zone, default now) and SEED_HOURS (default 72). */
export function parseDemoSeedEnv(
  env: Record<string, string | undefined>,
  now: Date = new Date(),
): { end: Date; hours: number } {
  let end = now;
  if (env.SEED_NOW) {
    const iso =
      /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
    const match = iso.exec(env.SEED_NOW);
    end = new Date(env.SEED_NOW);
    // Date rolls 2026-02-30 over to March: check the day exists.
    const dayExists =
      match &&
      new Date(Date.UTC(+match[1], +match[2] - 1, +match[3])).getUTCDate() ===
        +match[3];
    if (!dayExists || Number.isNaN(end.getTime())) {
      throw new Error(
        `SEED_NOW must be an ISO 8601 time with a zone (e.g. 2026-10-08T12:00:00Z), got "${env.SEED_NOW}"`,
      );
    }
  }
  let hours = DEMO_SEED_HOURS;
  if (env.SEED_HOURS) {
    hours = Number(env.SEED_HOURS);
    if (!Number.isInteger(hours) || hours < 1 || hours > DEMO_SEED_MAX_HOURS) {
      throw new Error(
        `SEED_HOURS must be a whole number from 1 to ${DEMO_SEED_MAX_HOURS}, got "${env.SEED_HOURS}"`,
      );
    }
  }
  return { end, hours };
}

/**
 * The demo seed: fixture farms, the DEMO_TURBINES, the DEMO_ALERT_RULES that don't exist yet, and
 * `hours` of generated telemetry up to `end`, with each new reading's triggered rules in
 * telemetry_alerts (the same insert as ingestion, one transaction per batch). Idempotent on
 * (turbine_id, timestamp): a re-run only adds the readings since the last one. Publishes no events.
 */
export async function seedDemo(
  prisma: PrismaClient,
  { dataDir, end, hours }: DemoSeedOptions,
): Promise<DemoSeedResult> {
  const farms = await seedFarmsFromCsv(prisma, dataDir);
  const farmIds = new Set(farms.map((f) => f.farm_id));
  for (const { turbineId, commissioned, ...data } of DEMO_TURBINES) {
    if (!farmIds.has(data.farmId)) {
      throw new Error(`Demo turbine ${turbineId}: unknown farm ${data.farmId}`);
    }
    // `commissioned` only when created: a re-seed never resets it.
    await prisma.turbine.upsert({
      where: { turbineId },
      create: { turbineId, commissioned, ...data },
      update: data,
    });
  }

  // ON CONFLICT DO NOTHING on (metric, comparison, level): existing rules win.
  const { count: rulesCreated } = await prisma.alertConfig.createMany({
    data: [...DEMO_ALERT_RULES],
    skipDuplicates: true,
  });
  const rules = await enabledAlertRules(prisma);

  const rows = generateTelemetry({
    turbines: DEMO_TURBINES,
    end: floorToTelemetryStep(end),
    hours,
    seed: DEMO_SEED,
  });
  let inserted = 0;
  let alerts = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const stored = await prisma.$transaction(
      (tx) =>
        insertTelemetryWithAlerts(
          tx,
          rows.slice(i, i + BATCH_SIZE).map(toTelemetryInput),
          rules,
        ),
      { timeout: 60_000 },
    );
    inserted += stored.length;
    alerts += stored.reduce((n, r) => n + r.alerts.length, 0);
  }

  return {
    farms: farms.length,
    turbines: DEMO_TURBINES.length,
    rulesCreated,
    rulesEvaluated: rules.length,
    rows: rows.length,
    inserted,
    skipped: rows.length - inserted,
    alerts,
    from: rows[0]?.timestamp ?? null,
    to: rows.at(-1)?.timestamp ?? null,
  };
}

function toTelemetryInput(r: GeneratedTelemetryRow) {
  return {
    turbineId: r.turbine_id,
    farmId: r.farm_id,
    timestamp: new Date(r.timestamp),
    receivedAt: new Date(r.received_at),
    powerOutputKw: r.power_output_kw,
    windSpeedMs: r.wind_speed_ms,
    rotorRpm: r.rotor_rpm,
    bladePitchDeg: r.blade_pitch_deg,
    gearboxTempC: r.gearbox_temp_c,
  };
}
