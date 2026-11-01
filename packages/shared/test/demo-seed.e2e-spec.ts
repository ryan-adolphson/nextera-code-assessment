import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, type Prisma } from '../src/generated/prisma/client.js';
import { DEMO_SEED, DEMO_TURBINES } from '../src/seed/demo-fleet.js';
import { DEMO_UNALLOCATED } from '../src/seed/demo-unallocated.js';
import {
  DEMO_ANOMALIES,
  demoReportingLagMinutes,
  generateTelemetry,
} from '../src/seed/generate-telemetry.js';
import { importHeld, lockUnallocated } from '../src/wind/unallocated.js';
import { openMigrationDb, type MigrationDb } from './migration-db.js';

const SHARED_DIR = fileURLToPath(new URL('..', import.meta.url));
const SEED_NOW = '2026-10-08T12:00:00Z';

/**
 * `npm run db:seed:demo` (the real prisma/seed-demo.ts) against a fully migrated database of its
 * own: telemetry and telemetry_alerts are written, a re-run inserts nothing, a later SEED_NOW tops
 * up, existing rules are never overwritten, and the DEMO_UNALLOCATED entries are created, topped up
 * and skipped once resolved.
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
  /** The unallocated entries with their held readings (count, oldest, newest). */
  const unallocated = async () =>
    (
      await m.db.query(`
        SELECT u.turbine_id, u.reported_farm_id, u.kind::text, u.status::text,
               u.first_seen_at, u.last_seen_at, u.blocked_at, b.email AS blocked_by,
               count(h.id)::int AS held, min(h.timestamp) AS oldest, max(h.timestamp) AS newest
        FROM unallocated_turbines u
        LEFT JOIN users b ON b.id = u.blocked_by
        LEFT JOIN held_telemetry h ON h.unallocated_id = u.id
        GROUP BY u.id, b.email
        ORDER BY u.status, u.turbine_id`)
    ).rows;
  const minutesBefore = (d: Date, end = SEED_NOW) =>
    (Date.parse(end) - d.getTime()) / 60_000;
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

    // The newest reading is at SEED_NOW, except the stale turbines: the stopped one 90 min
    // older, the lagging ones 20 and 45 min.
    const { rows: latest } = await m.db.query(`
      SELECT turbine_id, max(timestamp) AS latest FROM telemetry GROUP BY turbine_id`);
    expect(latest).toHaveLength(DEMO_TURBINES.length);
    for (const { turbine_id, latest: at } of latest) {
      expect(minutesBefore(at), turbine_id).toBe(
        demoReportingLagMinutes(turbine_id),
      );
    }
    expect(demoReportingLagMinutes(DEMO_ANOMALIES.stopped.turbineId)).toBe(90);
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
  it('seeded the unallocated entries: pending with held readings up to SEED_NOW, blocked with none', async () => {
    // State after the first three tests: seeded at 12:00, re-run, topped up to 13:00.
    const rows = await unallocated();
    expect(
      rows.map((u) => [
        u.turbine_id,
        u.reported_farm_id,
        u.kind,
        u.status,
        u.held,
        u.blocked_by,
      ]),
    ).toEqual([
      // pending (12 more readings each since the 13:00 top-up)
      ['TURB003', 'FARM02', 'farm_mismatch', 'pending', 24 + 12, null],
      ['TURB004', 'FARM99', 'farm_mismatch', 'pending', 12 + 12, null],
      ['TURB098', 'FARM99', 'unknown_turbine', 'pending', 36 + 12, null],
      ['TURB099', 'FARM01', 'unknown_turbine', 'pending', 72 + 12, null],
      // blocked: no held readings, never topped up
      [
        'TURB005',
        'FARM03',
        'farm_mismatch',
        'blocked',
        0,
        'owner@nextera.local',
      ],
      [
        'TURB097',
        'FARM05',
        'unknown_turbine',
        'blocked',
        0,
        'admin@nextera.local',
      ],
    ]);

    const LATER = '2026-10-08T13:00:00Z';
    for (const u of rows) {
      const plan = DEMO_UNALLOCATED.find((e) => e.turbineId === u.turbine_id)!;
      if (u.status === 'pending') {
        // The oldest is from the first run (12:00 end), the newest at the top-up's end.
        expect(minutesBefore(u.oldest), u.turbine_id).toBe(plan.hours * 60 - 5);
        expect(minutesBefore(u.newest, LATER), u.turbine_id).toBe(0);
        // Seen = receive times: 5–60 s after the first / newest reading.
        const seconds = (a: Date, b: Date) =>
          (a.getTime() - b.getTime()) / 1000;
        expect(seconds(u.first_seen_at, u.oldest)).toBeGreaterThanOrEqual(5);
        expect(seconds(u.first_seen_at, u.oldest)).toBeLessThan(60);
        expect(seconds(u.last_seen_at, u.newest)).toBeGreaterThanOrEqual(5);
        expect(seconds(u.last_seen_at, u.newest)).toBeLessThan(60);
        expect(u.blocked_at).toBeNull();
      } else {
        // Blocked (by the first run) at its offset before 12:00, after its last reading was seen.
        expect(minutesBefore(u.blocked_at)).toBe(plan.blocked!.offsetMinutes);
        expect(u.last_seen_at.getTime()).toBeLessThan(u.blocked_at.getTime());
        expect(minutesBefore(u.first_seen_at)).toBeLessThan(
          plan.endOffsetMinutes + plan.hours * 60,
        );
      }
    }
  });

  it('a re-run changes no unallocated entry', async () => {
    const before = await unallocated();
    const out = await seed('2026-10-08T13:00:00Z');
    expect(out).toMatch(
      /TURB099@FARM01 updated \(unknown_turbine, pending, \+0 held\)/,
    );
    expect(out).toMatch(/TURB097@FARM05 unchanged/);
    expect(await unallocated()).toEqual(before);
  });

  it('skips pairs resolved since (assigned, moved), keeps moves, and re-creates a kept pair', async () => {
    const prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: m.url }),
    });
    const entryId = async (turbineId: string, reportedFarmId: string) =>
      (
        await prisma.unallocatedTurbine.findUniqueOrThrow({
          where: { turbineId_reportedFarmId: { turbineId, reportedFarmId } },
        })
      ).id;
    try {
      // What the API's assign / move / keep do (create or move the turbine, import, delete).
      const resolve = (
        id: string,
        farmId: string,
        change: (tx: Prisma.TransactionClient) => Promise<unknown>,
      ) =>
        prisma.$transaction(async (tx) => {
          await lockUnallocated(tx, id);
          await change(tx);
          return importHeld(tx, id, farmId);
        });
      const assign = await entryId('TURB099', 'FARM01');
      await resolve(assign, 'FARM01', (tx) =>
        tx.turbine.create({
          data: {
            turbineId: 'TURB099',
            farmId: 'FARM01',
            latitude: 41.25,
            longitude: -96.53,
          },
        }),
      );
      const move = await entryId('TURB003', 'FARM02');
      await resolve(move, 'FARM02', (tx) =>
        tx.turbine.update({
          where: { turbineId: 'TURB003' },
          data: { farmId: 'FARM02' },
        }),
      );
      const keep = await entryId('TURB004', 'FARM99');
      await resolve(keep, 'FARM01', () => Promise.resolve());

      const out = await seed('2026-10-08T14:00:00Z');
      expect(out).toMatch(/TURB099@FARM01 resolved/);
      expect(out).toMatch(/TURB003@FARM02 resolved/);
      expect(out).toMatch(
        /TURB004@FARM99 created \(farm_mismatch, pending, \+12 held\)/,
      );

      const rows = await unallocated();
      expect(rows.map((u) => `${u.turbine_id}@${u.reported_farm_id}`)).toEqual([
        'TURB004@FARM99',
        'TURB098@FARM99',
        'TURB005@FARM03',
        'TURB097@FARM05',
      ]);
      // The move stays: TURB003 is on FARM02, with its new readings.
      const { rows: turb003 } = await m.db.query(`
        SELECT t.farm_id, (SELECT DISTINCT farm_id FROM telemetry
                           WHERE turbine_id = 'TURB003' AND timestamp = '2026-10-08T14:00:00Z') AS newest_farm
        FROM turbines t WHERE t.turbine_id = 'TURB003'`);
      expect(turb003).toEqual([{ farm_id: 'FARM02', newest_farm: 'FARM02' }]);
    } finally {
      await prisma.$disconnect();
    }
  });
});
