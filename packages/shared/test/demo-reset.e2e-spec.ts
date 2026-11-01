import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { DEMO_SEED, DEMO_TURBINES } from '../src/seed/demo-fleet.js';
import { DEMO_RESET_HOURS, databaseTarget } from '../src/seed/demo-reset.js';
import {
  DEMO_ANOMALIES,
  generateTelemetry,
} from '../src/seed/generate-telemetry.js';
import { openMigrationDb, type MigrationDb } from './migration-db.js';

const SHARED_DIR = fileURLToPath(new URL('..', import.meta.url));
const FIRST_SEED = '2026-10-08T12:00:00Z';
const RESET_NOW = '2026-10-09T12:00:00Z';
const PASSWORD = 'demo-reset-e2e-password';

/**
 * `npm run demo:reset` (the real prisma/demo-reset.ts, without weather and feed) against a fully
 * migrated database of its own: it deletes the readings (telemetry, alerts, held readings,
 * unallocated entries, weather), keeps farms, turbines (a moved one stays moved), users and rules,
 * and re-seeds 7 days whose stale turbines end at the expected times.
 */
describe('demo reset (e2e)', () => {
  let m: MigrationDb;

  beforeAll(async () => {
    m = await openMigrationDb('99999999999999_demo_reset');
    await m.migrateAll();
  });

  afterAll(async () => {
    await m?.close();
  });

  const exec = (script: string, args: string[], env: Record<string, string>) =>
    promisify(execFile)('npx', ['tsx', script, ...args], {
      cwd: SHARED_DIR,
      env: {
        ...process.env,
        DATABASE_URL: m.url,
        SEED_USER_PASSWORD: PASSWORD,
        ...env,
      },
    });
  /** Exit code, stdout and stderr, also on failure. */
  const reset = async (args: string[], env: Record<string, string> = {}) => {
    try {
      const { stdout, stderr } = await exec('prisma/demo-reset.ts', args, {
        SEED_NOW: RESET_NOW,
        ...env,
      });
      return { code: 0, stdout, stderr };
    } catch (error) {
      const e = error as { code: number; stdout: string; stderr: string };
      return { code: e.code, stdout: e.stdout, stderr: e.stderr };
    }
  };
  // Testcontainers maps to localhost here; if not, the guard needs --allow-remote.
  const allowRemote = () =>
    databaseTarget(m.url).local ? [] : ['--allow-remote'];
  const one = async (sql: string) => (await m.db.query(sql)).rows;
  const snapshot = async () => ({
    farms: await one(`SELECT id, name FROM farms ORDER BY id`),
    turbines: await one(
      `SELECT id, turbine_id, farm_id, commissioned FROM turbines ORDER BY turbine_id`,
    ),
    users: await one(
      `SELECT id, email, role::text, password_hash FROM users ORDER BY email`,
    ),
    rules: await one(
      `SELECT id, measurement_metric::text, comparison::text, value_metric, alert_level::text, enabled
       FROM alerts_config ORDER BY id`,
    ),
  });
  const counts = async () =>
    (
      await one(`
        SELECT (SELECT count(*) FROM telemetry)::int AS telemetry,
               (SELECT count(*) FROM telemetry_alerts)::int AS alerts,
               (SELECT count(*) FROM held_telemetry)::int AS held,
               (SELECT count(*) FROM unallocated_turbines)::int AS unallocated,
               (SELECT count(*) FROM farm_weather)::int AS weather`)
    )[0];

  it('refuses without --yes when stdin is not a terminal, and a remote host without --allow-remote', async () => {
    await exec('prisma/seed-demo.ts', [], {
      SEED_NOW: FIRST_SEED,
      SEED_HOURS: '72',
    });
    const before = await counts();
    expect(before.telemetry).toBeGreaterThan(0);

    const noYes = await reset(['--no-weather', '--no-feed', ...allowRemote()]);
    expect(noYes.code).toBe(1);
    expect(noYes.stderr).toMatch(/Refusing to reset without --yes/);

    const remote = new URL(m.url);
    remote.hostname = 'db.example.invalid';
    const refused = await reset(['--yes', '--no-weather', '--no-feed'], {
      DATABASE_URL: remote.toString(),
    });
    expect(refused.code).toBe(1);
    expect(refused.stdout).toContain(
      `Target database: db.example.invalid:${remote.port}/${remote.pathname.slice(1)} (REMOTE)`,
    );
    expect(refused.stderr).toMatch(
      /Refusing to reset db\.example\.invalid.*--allow-remote/,
    );
    // Never the password.
    expect(refused.stdout + refused.stderr).not.toContain(
      decodeURIComponent(remote.password),
    );

    expect(await counts()).toEqual(before);
  });

  it('deletes the readings, keeps the setup (and a move), and re-seeds 7 days with the stale turbines', async () => {
    // State before: the demo seed (previous test), plus a user rule, a moved turbine, weather,
    // and an old reading outside the new window.
    await m.db.query(`
      INSERT INTO alerts_config (measurement_metric, comparison, value_metric, alert_level, enabled)
      VALUES ('rotor_rpm', 'above', 25, 'warn', false)`);
    // A move (Unallocated → Move): telemetry follows through ON UPDATE CASCADE.
    await m.db.query(
      `UPDATE turbines SET farm_id = 'FARM02' WHERE turbine_id = 'TURB003'`,
    );
    await m.db.query(`
      INSERT INTO farm_weather (farm_id, time, samples, wind_speed_80m_ms)
      VALUES ('FARM01', '2026-10-08T00:00:00Z', 2, 9.5)`);
    await m.db.query(`
      INSERT INTO telemetry (turbine_id, farm_id, timestamp, received_at, power_output_kw,
                             wind_speed_ms, rotor_rpm, blade_pitch_deg, gearbox_temp_c)
      VALUES ('TURB010', 'FARM04', '2026-09-01T00:00:00Z', '2026-09-01T00:00:10Z', 1000, 8, 14, 3, 80)`);
    const before = await snapshot();
    expect(await counts()).toMatchObject({ weather: 1 });

    const { code, stdout, stderr } = await reset([
      '--yes',
      '--no-weather',
      '--no-feed',
      ...allowRemote(),
    ]);
    expect(stderr).toBe('');
    expect(code).toBe(0);
    expect(stdout).toMatch(/Target database: .*\/migration_\w+ \(local\)/);
    expect(stdout).not.toContain(PASSWORD);
    expect(stdout).toMatch(
      /Deleted \d+ telemetry rows, 7 telemetry_alerts, \d+ held readings, 6 unallocated entries, 1 weather rows/,
    );
    expect(stdout).toMatch(/Live feed: skipped \(--no-feed\)/);

    // The setup is untouched: same ids, the move kept, the user's rule kept.
    const after = await snapshot();
    expect(after.farms).toEqual(before.farms);
    expect(after.turbines).toEqual(before.turbines);
    expect(after.rules).toEqual(before.rules);
    expect(after.users.map((u) => [u.id, u.email, u.role])).toEqual(
      before.users.map((u) => [u.id, u.email, u.role]),
    );
    expect(
      after.turbines.find((t) => t.turbine_id === 'TURB003')?.farm_id,
    ).toBe('FARM02');

    // Exactly the 7-day seed for the fleet as it is now (TURB003 on FARM02): the old reading and
    // the first seed's anomalies are gone, the new ones are at their offsets from RESET_NOW.
    const turbines = after.turbines.map((t) => ({
      turbineId: t.turbine_id as string,
      farmId: t.farm_id as string,
    }));
    const expected = generateTelemetry({
      turbines: DEMO_TURBINES.map((d) =>
        turbines.find((t) => t.turbineId === d.turbineId)!,
      ),
      end: new Date(RESET_NOW),
      hours: DEMO_RESET_HOURS,
      seed: DEMO_SEED,
    });
    const c = await counts();
    expect(c).toMatchObject({
      telemetry: expected.length,
      alerts: 7,
      weather: 0,
    });
    expect(
      await one(
        `SELECT 1 FROM telemetry WHERE timestamp = '2026-09-01T00:00:00Z'`,
      ),
    ).toEqual([]);
    const minutesBefore = (d: Date) =>
      (Date.parse(RESET_NOW) - d.getTime()) / 60_000;
    const flagged = await one(`
      SELECT t.turbine_id, t.timestamp FROM telemetry_alerts ta
      JOIN telemetry t ON t.id = ta.telemetry_id ORDER BY t.timestamp`);
    expect(
      flagged.map((f) => [f.turbine_id, minutesBefore(f.timestamp)]),
    ).toEqual([
      ...[0, 5, 10].map((x) => [
        'TURB001',
        DEMO_ANOMALIES.frozenPower.offsetMinutes - x,
      ]),
      ['TURB002', DEMO_ANOMALIES.pitchSpike.offsetMinutes],
      ...[0, 5, 10].map((x) => [
        'TURB002',
        DEMO_ANOMALIES.gearboxStuck.offsetMinutes - x,
      ]),
    ]);
    const oldest = await one(`SELECT min(timestamp) AS t FROM telemetry`);
    expect(minutesBefore(oldest[0].t)).toBe(DEMO_RESET_HOURS * 60 - 5);

    // Latest reading per turbine: the stale ones at their lag, everyone else at RESET_NOW.
    const latest = await one(
      `SELECT turbine_id, max(timestamp) AS latest FROM telemetry GROUP BY turbine_id`,
    );
    const behind = Object.fromEntries(
      latest.map((l) => [l.turbine_id, minutesBefore(l.latest)]),
    );
    expect(behind).toMatchObject({ TURB011: 20, TURB018: 45, TURB013: 90 });
    const others = Object.entries(behind).filter(
      ([id]) => !['TURB011', 'TURB018', 'TURB013'].includes(id),
    );
    expect(others).toHaveLength(DEMO_TURBINES.length - 3);
    expect(others.every(([, minutes]) => minutes === 0)).toBe(true);
    expect(stdout).toMatch(
      /TURB011 \(FARM04, lagging, 20 min behind\): 2026-10-09T11:40:00\.000Z/,
    );
    expect(stdout).toMatch(
      /TURB018 \(FARM07, lagging, 45 min behind\): 2026-10-09T11:15:00\.000Z/,
    );
    expect(stdout).toMatch(
      /TURB013 \(FARM05, stopped, 90 min behind\): 2026-10-09T10:30:00\.000Z/,
    );

    // Unallocated entries re-created, except TURB003@FARM02 (TURB003 is on FARM02 now).
    const entries = await one(`
      SELECT turbine_id || '@' || reported_farm_id AS pair, status::text
      FROM unallocated_turbines ORDER BY status::text DESC, turbine_id`);
    expect(entries).toEqual([
      { pair: 'TURB004@FARM99', status: 'pending' },
      { pair: 'TURB098@FARM99', status: 'pending' },
      { pair: 'TURB099@FARM01', status: 'pending' },
      { pair: 'TURB005@FARM03', status: 'blocked' },
      { pair: 'TURB097@FARM05', status: 'blocked' },
    ]);
  });
});
