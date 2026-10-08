import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DEMO_SEED, DEMO_TURBINES } from '../src/seed/demo-fleet.js';
import {
  DEMO_ANOMALIES,
  generateTelemetry,
} from '../src/seed/generate-telemetry.js';
import { openMigrationDb, type MigrationDb } from './migration-db.js';

const SHARED_DIR = fileURLToPath(new URL('..', import.meta.url));
const SEED_NOW = '2026-10-08T12:00:00Z';

/**
 * `npm run db:seed:demo` (the real prisma/seed-demo.ts) against a fully migrated database of its
 * own: telemetry and telemetry_alerts are written, a re-run inserts nothing, a later SEED_NOW tops
 * up, and existing rules are never overwritten.
 */
describe('demo seed (e2e)', () => {
  let m: MigrationDb;

  // A sentinel target after every migration: migrateAll() applies them all.
  beforeAll(async () => {
    m = await openMigrationDb('99999999999999_demo_seed');
    await m.migrateAll();
    // A rule the user already has for (gearbox, above, error): the seed must keep it as it is.
    await m.db.query(`
      INSERT INTO alerts_config (measurement_metric, comparison, value_metric, alert_level)
      VALUES ('gearbox_temp_c', 'above', 120, 'error')`);
  });

  afterAll(async () => {
    await m?.close();
  });

  const seed = async (seedNow = SEED_NOW) => {
    const { stdout } = await promisify(execFile)(
      'npx',
      ['tsx', 'prisma/seed-demo.ts'],
      {
        cwd: SHARED_DIR,
        env: {
          ...process.env,
          DATABASE_URL: m.url,
          SEED_NOW: seedNow,
          SEED_HOURS: '72',
          SEED_USER_PASSWORD: 'demo-seed-e2e-password',
        },
      },
    );
    return stdout;
  };
  const counts = async () =>
    (
      await m.db.query(`
        SELECT (SELECT count(*) FROM farms)::int AS farms,
               (SELECT count(*) FROM turbines)::int AS turbines,
               (SELECT count(*) FROM telemetry)::int AS telemetry,
               (SELECT count(*) FROM telemetry_alerts)::int AS alerts,
               (SELECT count(*) FROM users)::int AS users`)
    ).rows[0];
  const expectedRows = (end: string) =>
    generateTelemetry({
      turbines: DEMO_TURBINES,
      end: new Date(end),
      hours: 72,
      seed: DEMO_SEED,
    });

  it('seeds users, farms, demo turbines, the missing default rules, telemetry and telemetry_alerts', async () => {
    const out = await seed();
    expect(out).toMatch(
      /2 default alert rules created \(3 enabled rules evaluated\)/,
    );

    const rows = expectedRows(SEED_NOW);
    expect(await counts()).toEqual({
      farms: 10,
      turbines: DEMO_TURBINES.length,
      telemetry: rows.length,
      alerts: 7,
      users: 3,
    });

    const { rows: rules } = await m.db.query(`
      SELECT measurement_metric::text AS metric, comparison::text, value_metric, alert_level::text AS level
      FROM alerts_config ORDER BY measurement_metric, alert_level`);
    expect(rules).toEqual([
      {
        metric: 'power_output_kw',
        comparison: 'below',
        value_metric: 100,
        level: 'warn',
      },
      {
        metric: 'blade_pitch_deg',
        comparison: 'above',
        value_metric: 30,
        level: 'info',
      },
      // Existing rule, not overwritten with 100.
      {
        metric: 'gearbox_temp_c',
        comparison: 'above',
        value_metric: 120,
        level: 'error',
      },
    ]);

    const { rows: flagged } = await m.db.query(`
      SELECT t.turbine_id, t.timestamp, a.measurement_metric::text AS metric
      FROM telemetry_alerts ta
      JOIN telemetry t ON t.id = ta.telemetry_id
      JOIN alerts_config a ON a.id = ta.alert_id
      ORDER BY t.timestamp`);
    const minutesBefore = (d: Date) =>
      (Date.parse(SEED_NOW) - d.getTime()) / 60_000;
    expect(
      flagged.map((f) => [f.turbine_id, minutesBefore(f.timestamp), f.metric]),
    ).toEqual([
      ...[0, 5, 10].map((m) => [
        'TURB001',
        DEMO_ANOMALIES.frozenPower.offsetMinutes - m,
        'power_output_kw',
      ]),
      ['TURB002', DEMO_ANOMALIES.pitchSpike.offsetMinutes, 'blade_pitch_deg'],
      ...[0, 5, 10].map((m) => [
        'TURB002',
        DEMO_ANOMALIES.gearboxStuck.offsetMinutes - m,
        'gearbox_temp_c',
      ]),
    ]);

    // The newest reading is at SEED_NOW; the stopped turbine's is 40 min older.
    const { rows: latest } = await m.db.query(`
      SELECT turbine_id, max(timestamp) AS latest FROM telemetry GROUP BY turbine_id`);
    for (const { turbine_id, latest: at } of latest) {
      expect(minutesBefore(at), turbine_id).toBe(
        turbine_id === DEMO_ANOMALIES.stopped.turbineId ? 40 : 0,
      );
    }
  });

  it('inserts nothing on a second run with the same SEED_NOW', async () => {
    const before = await counts();
    const out = await seed();
    expect(out).toMatch(/0 telemetry rows inserted/);
    expect(out).toMatch(/0 default alert rules created/);
    expect(await counts()).toEqual(before);
  });

  it('tops up to a later SEED_NOW', async () => {
    const before = await counts();
    await seed('2026-10-08T13:00:00Z');

    const keys = (rows: ReturnType<typeof expectedRows>) =>
      new Set(rows.map((r) => `${r.turbine_id}@${r.timestamp}`));
    const old = keys(expectedRows(SEED_NOW));
    const added = [...keys(expectedRows('2026-10-08T13:00:00Z'))].filter(
      (k) => !old.has(k),
    );
    expect((await counts()).telemetry).toBe(before.telemetry + added.length);
    // The anomalies' new offsets fall on readings stored as normal: no new alerts.
    expect((await counts()).alerts).toBe(before.alerts);
  });
});
