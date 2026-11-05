import type { PrismaClient } from '../generated/prisma/client.js';
import { runLiveSummary } from '../wind/live-summary.js';
import { ensureTelemetryPartitions } from '../wind/partitions.js';
import { refreshTurbineLatest } from '../wind/turbine-latest.js';
import { DEMO_ALERT_RULES } from './demo-fleet.js';

/**
 * The scale seed (`npm run db:seed:scale`): a fleet of a million turbines for load tests and for
 * trying the app at its design size, built with set-based SQL (`generate_series`, no rows in
 * Node). Local databases only. Idempotent: ids are deterministic, rows that exist are kept, and a
 * re-run moves the latest readings (and the sample's telemetry) up to `now`.
 *
 * - `farms` farms `SFARM00001…` on a grid, `turbines` turbines `STURB0000001…` spread evenly over
 *   them (at most 2,000 per farm), every 7th uncommissioned;
 * - `turbine_latest` for every turbine: a synthetic newest reading (90 % reporting now, 7 % 20 min
 *   behind, 2 % 45 min, 1 % 3 h; ~2.5 % with a warn/error), except the sample, whose row comes
 *   from the readings below;
 * - `hours` of 5-minute telemetry (default 24 h) with their triggered alerts for a sample of
 *   `samplePercent` % of the turbines (default 1 % = 10,000 turbines, ~2.9M readings), through the
 *   daily partitions;
 * - `farm_live_summary` for every farm.
 * The farm and anomaly rollups are not run (`npm run rollup`, `npm run anomalies:rollup`).
 * The readings are deterministic functions of the turbine id and the time, not random.
 */

export const SCALE_DEFAULT_FARMS = 10_000;
export const SCALE_DEFAULT_TURBINES = 1_000_000;
export const SCALE_DEFAULT_SAMPLE_PERCENT = 1;
export const SCALE_DEFAULT_HOURS = 24;
export const SCALE_MAX_TURBINES_PER_FARM = 2000;
const STEP_MS = 5 * 60_000;
const TURBINE_BATCH = 100_000;
const SAMPLE_BATCH = 1000;

export interface ScaleSeedOptions {
  farms: number;
  turbines: number;
  /** 0 to 100: the share of turbines that get telemetry. */
  samplePercent: number;
  hours: number;
  /** The newest measurement time (floored to 5 minutes). */
  now: Date;
}

export interface ScaleSeedResult {
  farms: number;
  turbines: number;
  sampleTurbines: number;
  telemetryRows: number;
  alerts: number;
  from: string;
  to: string;
}

const wholeNumber = (
  env: Record<string, string | undefined>,
  name: string,
  fallback: number,
  min: number,
  max: number,
): number => {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value < min || value > max) {
    throw new Error(
      `${name} must be a whole number from ${min} to ${max}, got "${raw}"`,
    );
  }
  return value;
};

/** SCALE_FARMS, SCALE_TURBINES, SCALE_SAMPLE_PERCENT, SCALE_HOURS, SCALE_NOW (ISO). */
export function parseScaleSeedEnv(
  env: Record<string, string | undefined>,
  now: Date = new Date(),
): ScaleSeedOptions {
  const farms = wholeNumber(
    env,
    'SCALE_FARMS',
    SCALE_DEFAULT_FARMS,
    1,
    100_000,
  );
  const turbines = wholeNumber(
    env,
    'SCALE_TURBINES',
    SCALE_DEFAULT_TURBINES,
    1,
    10_000_000,
  );
  if (Math.ceil(turbines / farms) > SCALE_MAX_TURBINES_PER_FARM) {
    throw new Error(
      `SCALE_TURBINES / SCALE_FARMS may be at most ${SCALE_MAX_TURBINES_PER_FARM} turbines per farm`,
    );
  }
  let end = now;
  if (env.SCALE_NOW) {
    end = new Date(env.SCALE_NOW);
    if (Number.isNaN(end.getTime())) {
      throw new Error(
        `SCALE_NOW must be an ISO timestamp, got "${env.SCALE_NOW}"`,
      );
    }
  }
  return {
    farms,
    turbines,
    samplePercent: wholeNumber(
      env,
      'SCALE_SAMPLE_PERCENT',
      SCALE_DEFAULT_SAMPLE_PERCENT,
      0,
      100,
    ),
    hours: wholeNumber(env, 'SCALE_HOURS', SCALE_DEFAULT_HOURS, 1, 31 * 24),
    now: end,
  };
}

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Throws unless `url` points at this machine, like load/local-db.js: `?host=` and `?hostaddr=`
 * override the URL's host in libpq-style URLs (Cloud SQL URLs here use `?host=/cloudsql/…`), so
 * they are checked too. It can't see through a TCP proxy on localhost. The message names the
 * host only (the URL holds the password).
 */
export function assertLocalDatabase(url: string | undefined): void {
  if (!url) throw new Error('DATABASE_URL is not set.');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('DATABASE_URL is not a valid URL.');
  }
  const hosts = [
    parsed.hostname,
    parsed.searchParams.get('host'),
    parsed.searchParams.get('hostaddr'),
  ].filter((host): host is string => host !== null);
  const remote = hosts.find((host) => !LOCAL_HOSTS.has(host));
  if (!/^postgres(ql)?:$/.test(parsed.protocol) || remote !== undefined) {
    throw new Error(
      `Refusing to seed a million turbines: DATABASE_URL must be a local postgres URL (host "${remote ?? ''}").`,
    );
  }
}

/** Seeds the scale fleet (see the module comment). */
export async function seedScale(
  prisma: PrismaClient,
  options: ScaleSeedOptions,
  log: (line: string) => void = () => undefined,
): Promise<ScaleSeedResult> {
  const { farms, turbines, samplePercent, hours } = options;
  const perFarm = Math.ceil(turbines / farms);
  const end = new Date(Math.floor(options.now.getTime() / STEP_MS) * STEP_MS);
  const start = new Date(end.getTime() - (hours * 12 - 1) * STEP_MS);
  // Every `modulus`-th turbine is in the sample (0 = none).
  const modulus =
    samplePercent > 0 ? Math.max(1, Math.round(100 / samplePercent)) : 0;

  await prisma.alertConfig.createMany({
    data: [...DEMO_ALERT_RULES],
    skipDuplicates: true,
  });

  log(`Farms: ${farms}`);
  await prisma.$executeRaw`
    INSERT INTO farms (id, name, latitude, longitude)
    SELECT 'SFARM' || lpad(g::text, 5, '0'), 'Scale Farm ' || g,
           round((25 + ((g - 1) % 100) * 0.25)::numeric, 6),
           round((-125 + (((g - 1) / 100) % 200) * 0.25)::numeric, 6)
    FROM generate_series(1, ${farms}::int) g
    ON CONFLICT (id) DO NOTHING`;

  log(`Turbines: ${turbines} (${perFarm} per farm)`);
  for (let a = 1; a <= turbines; a += TURBINE_BATCH) {
    const b = Math.min(turbines, a + TURBINE_BATCH - 1);
    await prisma.$executeRaw`
      INSERT INTO turbines (turbine_id, farm_id, latitude, longitude, commissioned)
      SELECT 'STURB' || lpad(i::text, 7, '0'),
             'SFARM' || lpad(f.n::text, 5, '0'),
             f.lat + ((i % 20) - 10) * 0.002,
             f.lon + (((i / 20) % 20) - 10) * 0.002,
             i % 7 <> 0
      FROM generate_series(${a}::int, ${b}::int) i
      CROSS JOIN LATERAL (SELECT least(${farms}::int, (i - 1) / ${perFarm}::int + 1) AS n) pick
      JOIN LATERAL (
        SELECT pick.n,
               (25 + ((pick.n - 1) % 100) * 0.25) AS lat,
               (-125 + (((pick.n - 1) / 100) % 200) * 0.25) AS lon
      ) f ON true
      ON CONFLICT (turbine_id) DO NOTHING`;
    log(`  turbines ${b} / ${turbines}`);
  }

  log('turbine_latest (synthetic, all but the sample)');
  for (let a = 1; a <= turbines; a += TURBINE_BATCH) {
    const b = Math.min(turbines, a + TURBINE_BATCH - 1);
    await prisma.$executeRaw`
      WITH base AS (
        SELECT t.turbine_id, t.farm_id,
               (abs(hashtextextended(t.turbine_id, 1)) % 10000) / 10000.0 AS r1,
               (abs(hashtextextended(t.turbine_id, 2)) % 10000) / 10000.0 AS r2,
               (abs(hashtextextended(t.turbine_id, 3)) % 10000) / 10000.0 AS r3,
               (abs(hashtextextended(t.turbine_id, 4)) % 10000) / 10000.0 AS r4,
               abs(hashtextextended(t.turbine_id, 42)) % 1000 AS lag_roll
        FROM generate_series(${a}::int, ${b}::int) i
        JOIN turbines t ON t.turbine_id = 'STURB' || lpad(i::text, 7, '0')
        WHERE ${modulus}::int = 0 OR i % ${modulus}::int <> 0
      ),
      shaped AS (
        SELECT *,
               3 + r1 * 12 AS wind,
               ${end}::timestamptz - make_interval(mins => CASE
                 WHEN lag_roll < 900 THEN 0 WHEN lag_roll < 970 THEN 20
                 WHEN lag_roll < 990 THEN 45 ELSE 180 END) AS ts
        FROM base
      ),
      metrics AS (
        SELECT *,
               CASE WHEN wind < 3.5 THEN 0
                    ELSE least(3500, 3500 * power(least(wind, 12) / 12.0, 3)) * (0.9 + 0.1 * r2) END AS p
        FROM shaped
      )
      INSERT INTO turbine_latest (turbine_id, farm_id, reading_id, "timestamp", received_at,
                                  power_output_kw, wind_speed_ms, rotor_rpm, blade_pitch_deg,
                                  gearbox_temp_c, worst_alert_level)
      SELECT turbine_id, farm_id, gen_random_uuid(), ts, ts + interval '20 seconds',
             p, wind, CASE WHEN p = 0 THEN 0 ELSE 6 + wind * 0.9 END,
             CASE WHEN wind > 12 THEN (wind - 12) * 5 ELSE 2 + r3 END,
             40 + p / 3500 * 40 + r4 * 5,
             CASE WHEN r4 < 0.02 THEN 'warn'::alert_level
                  WHEN r4 < 0.025 THEN 'error'::alert_level END
      FROM metrics
      ORDER BY turbine_id COLLATE "C"
      ON CONFLICT (turbine_id) DO UPDATE SET
        reading_id = EXCLUDED.reading_id, "timestamp" = EXCLUDED."timestamp",
        received_at = EXCLUDED.received_at, power_output_kw = EXCLUDED.power_output_kw,
        wind_speed_ms = EXCLUDED.wind_speed_ms, rotor_rpm = EXCLUDED.rotor_rpm,
        blade_pitch_deg = EXCLUDED.blade_pitch_deg, gearbox_temp_c = EXCLUDED.gearbox_temp_c,
        worst_alert_level = EXCLUDED.worst_alert_level
      WHERE turbine_latest."timestamp" < EXCLUDED."timestamp"`;
    log(`  turbine_latest ${b} / ${turbines}`);
  }

  let telemetryRows = 0;
  let alerts = 0;
  let sampleTurbines = 0;
  if (modulus > 0) {
    sampleTurbines = Math.floor(turbines / modulus);
    await ensureTelemetryPartitions(prisma, start, end);
    log(`Telemetry: ${sampleTurbines} sample turbines, ${hours} h`);
    for (let first = 1; first <= sampleTurbines; first += SAMPLE_BATCH) {
      const last = Math.min(sampleTurbines, first + SAMPLE_BATCH - 1);
      const ids = Array.from(
        { length: last - first + 1 },
        (_, k) => `STURB${String((first + k) * modulus).padStart(7, '0')}`,
      );
      const result = await prisma.$transaction(
        async (tx) => {
          const rows = await tx.$executeRaw`
            INSERT INTO telemetry (turbine_id, farm_id, "timestamp", received_at, power_output_kw,
                                   wind_speed_ms, rotor_rpm, blade_pitch_deg, gearbox_temp_c)
            SELECT t.turbine_id, t.farm_id, ts, ts + interval '20 seconds', m.p, m.wind,
                   CASE WHEN m.p = 0 THEN 0 ELSE 6 + m.wind * 0.9 END,
                   CASE WHEN m.wind > 12 THEN (m.wind - 12) * 5 ELSE 2 + m.phase END,
                   40 + m.p / 3500 * 40 + m.phase * 5
            FROM turbines t
            CROSS JOIN LATERAL generate_series(${start}::timestamptz, ${end}::timestamptz, interval '5 minutes') ts
            CROSS JOIN LATERAL (
              SELECT (abs(hashtextextended(t.turbine_id, 7)) % 10000) / 10000.0 AS phase
            ) ph
            CROSS JOIN LATERAL (
              SELECT ph.phase,
                     greatest(0, 8 + 5 * sin(extract(epoch FROM ts) / 7200.0 + ph.phase * 6.28)
                                 + 1.5 * sin(extract(epoch FROM ts) / 600.0 + ph.phase * 12.5)) AS wind
            ) w
            CROSS JOIN LATERAL (
              SELECT w.phase, w.wind,
                     CASE WHEN w.wind < 3.5 THEN 0
                          ELSE least(3500, 3500 * power(least(w.wind, 12) / 12.0, 3)) END AS p
            ) m
            WHERE t.turbine_id = ANY (${ids}::text[])
            ON CONFLICT DO NOTHING`;
          // Triggered alerts of this chunk's readings, from the enabled rules (set-based).
          const links = await tx.$executeRaw`
            INSERT INTO telemetry_alerts (telemetry_id, reading_timestamp, alert_id)
            SELECT r.id, r."timestamp", c.id
            FROM telemetry r
            CROSS JOIN alerts_config c
            CROSS JOIN LATERAL (
              SELECT CASE c.measurement_metric::text
                       WHEN 'power_output_kw' THEN r.power_output_kw
                       WHEN 'wind_speed_ms' THEN r.wind_speed_ms
                       WHEN 'rotor_rpm' THEN r.rotor_rpm
                       WHEN 'blade_pitch_deg' THEN r.blade_pitch_deg
                       ELSE r.gearbox_temp_c END AS v
            ) value
            WHERE c.enabled
              AND r.turbine_id = ANY (${ids}::text[])
              AND r."timestamp" >= ${start} AND r."timestamp" <= ${end}
              AND CASE c.comparison::text
                    WHEN 'above' THEN value.v > c.value_metric
                    ELSE value.v < c.value_metric END
            ON CONFLICT DO NOTHING`;
          await refreshTurbineLatest(tx, ids);
          return { rows, links };
        },
        { timeout: 10 * 60_000 },
      );
      telemetryRows += result.rows;
      alerts += result.links;
      log(
        `  sample turbines ${last} / ${sampleTurbines} (${telemetryRows} readings)`,
      );
    }
  }

  log('farm_live_summary');
  await runLiveSummary(prisma, { now: end });
  await prisma.$executeRawUnsafe(
    'ANALYZE farms, turbines, turbine_latest, telemetry, telemetry_alerts, farm_live_summary',
  );

  return {
    farms,
    turbines,
    sampleTurbines,
    telemetryRows,
    alerts,
    from: start.toISOString(),
    to: end.toISOString(),
  };
}
