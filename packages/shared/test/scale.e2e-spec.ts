import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { seedFarmsFromCsv, seedFromCsv } from '../src/seed/seed-from-csv.js';
import { seedDemo } from '../src/seed/seed-demo.js';
import { runAnomalyRollup } from '../src/wind/anomaly-rollup.js';
import { runLiveSummary } from '../src/wind/live-summary.js';
import {
  ensureTelemetryPartition,
  PARTITION_MAINTENANCE_LOCK,
  runPartitionMaintenance,
} from '../src/wind/partitions.js';
import { listAnomalies } from '../src/wind/queries.js';
import { toAnomaliesResponse, type AnomalyRow } from '../src/wind/responses.js';
import {
  enabledAlertRules,
  insertTelemetryWithAlerts,
} from '../src/wind/store-telemetry.js';
import {
  refreshTurbineLatest,
  upsertTurbineLatest,
} from '../src/wind/turbine-latest.js';
import {
  classifyReadings,
  holdReadings,
  importHeld,
  lockUnallocated,
} from '../src/wind/unallocated.js';
import { openMigrationDb, type MigrationDb } from './migration-db.js';

const DATA_DIR = fileURLToPath(new URL('../prisma/data', import.meta.url));
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

interface Reading {
  turbineId: string;
  at: number;
  power?: number;
  wind?: number;
  gearbox?: number;
  rpm?: number;
  farmId?: string;
}

/**
 * The scale redesign against a real Postgres: turbine_latest (newer-only upserts, deadlock-free
 * ordering, moves, imports, seeds), partition maintenance (carving DEFAULT, retention with
 * alerts, partition pruning), the live summary, and the anomaly rollup (equal to listAnomalies,
 * incremental, idempotent).
 */
describe('scale (e2e)', () => {
  let m: MigrationDb;
  let prisma: PrismaClient;

  beforeAll(async () => {
    m = await openMigrationDb('99999999999999_scale');
    await m.migrateAll();
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: m.url }),
    });
    await seedFarmsFromCsv(prisma, DATA_DIR);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await m?.close();
  });

  const reset = async () => {
    await prisma.$executeRaw`TRUNCATE TABLE turbine_latest, farm_live_summary, anomaly_episodes, anomaly_expected_power, anomaly_rollup_state, telemetry_alerts, telemetry, held_telemetry, unallocated_turbines, alerts_config, turbines`;
    await prisma.turbine.createMany({
      data: ['T1', 'T2', 'T3', 'T4'].map((turbineId, i) => ({
        turbineId,
        farmId: i < 3 ? 'FARM01' : 'FARM02',
        latitude: 41,
        longitude: -96,
        commissioned: i !== 1,
      })),
    });
    await prisma.alertConfig.createMany({
      data: [
        {
          measurementMetric: 'gearboxTempC',
          comparison: 'above',
          valueMetric: 100,
          alertLevel: 'error',
        },
        {
          measurementMetric: 'powerOutputKw',
          comparison: 'below',
          valueMetric: 100,
          alertLevel: 'warn',
        },
      ],
    });
  };

  const store = (readings: Reading[]) =>
    prisma.$transaction(async (tx) =>
      insertTelemetryWithAlerts(
        tx,
        readings.map((r) => ({
          turbineId: r.turbineId,
          farmId: r.farmId ?? (r.turbineId === 'T4' ? 'FARM02' : 'FARM01'),
          timestamp: new Date(r.at),
          receivedAt: new Date(r.at + 20_000),
          powerOutputKw: r.power ?? 2000,
          windSpeedMs: r.wind ?? 8,
          rotorRpm: r.rpm ?? 14,
          bladePitchDeg: 3,
          gearboxTempC: r.gearbox ?? 70,
        })),
        await enabledAlertRules(tx),
      ),
    );

  const latest = (turbineId: string) =>
    prisma.turbineLatest.findUnique({ where: { turbineId } });

  describe('turbine_latest', () => {
    beforeEach(reset);
    const T0 = Date.UTC(2026, 10, 3, 12, 0);

    it('keeps the newest reading per turbine with its worst alert level, and never lets a late one overwrite it', async () => {
      // One batch: three readings of T1 (newest hot: error + nothing else), one of T2.
      await store([
        { turbineId: 'T1', at: T0 + 10 * MIN, gearbox: 70 },
        { turbineId: 'T1', at: T0 + 15 * MIN, gearbox: 130 },
        { turbineId: 'T1', at: T0 + 5 * MIN, gearbox: 70 },
        { turbineId: 'T2', at: T0 },
      ]);
      expect(await latest('T1')).toMatchObject({
        farmId: 'FARM01',
        timestamp: new Date(T0 + 15 * MIN),
        gearboxTempC: 130,
        worstAlertLevel: 'error',
      });
      const hot = await prisma.telemetry.findFirstOrThrow({
        where: { turbineId: 'T1', timestamp: new Date(T0 + 15 * MIN) },
      });
      expect((await latest('T1'))!.readingId).toBe(hot.id);

      // A late reading (older than the row) is stored but doesn't touch it.
      await store([{ turbineId: 'T1', at: T0 - HOUR, gearbox: 20 }]);
      expect((await latest('T1'))!.timestamp).toEqual(new Date(T0 + 15 * MIN));
      expect(await prisma.telemetry.count({ where: { turbineId: 'T1' } })).toBe(
        4,
      );

      // A newer one replaces it, and its own (lower) alert level replaces the old one.
      await store([{ turbineId: 'T1', at: T0 + 20 * MIN, power: 50 }]);
      expect(await latest('T1')).toMatchObject({
        timestamp: new Date(T0 + 20 * MIN),
        worstAlertLevel: 'warn', // power below 100
      });
    });

    it('a duplicate reading changes nothing', async () => {
      await store([{ turbineId: 'T1', at: T0, power: 1500 }]);
      const before = await latest('T1');
      await store([{ turbineId: 'T1', at: T0, power: 999 }]);
      expect(await latest('T1')).toEqual(before);
    });

    it('concurrent transactions over the same turbines in opposite orders do not deadlock', async () => {
      const turbines = Array.from(
        { length: 40 },
        (_, i) => `D${String(i).padStart(2, '0')}`,
      );
      await prisma.turbine.createMany({
        data: turbines.map((turbineId) => ({
          turbineId,
          farmId: 'FARM01',
          latitude: 1,
          longitude: 1,
        })),
      });
      const candidate = (turbineId: string, minute: number) => ({
        id: `00000000-0000-4000-8000-${String(minute).padStart(12, '0')}`,
        turbineId,
        farmId: 'FARM01',
        timestamp: new Date(T0 + minute * MIN),
        receivedAt: new Date(T0),
        powerOutputKw: 1,
        windSpeedMs: 1,
        rotorRpm: 1,
        bladePitchDeg: 1,
        gearboxTempC: 1,
        worstAlertLevel: null,
      });
      // Without the sorted write order, two of these would lock rows in opposite orders.
      const runs = Array.from({ length: 12 }, (_, k) =>
        prisma.$transaction(async (tx) => {
          const order = k % 2 ? [...turbines].reverse() : turbines;
          await upsertTurbineLatest(
            tx,
            order.map((t) => candidate(t, 1 + k)),
          );
          await new Promise((r) => setTimeout(r, 20)); // keep the locks a moment
        }),
      );
      await expect(Promise.all(runs)).resolves.toHaveLength(12);
      expect(
        await prisma.turbineLatest.count({
          where: { turbineId: { startsWith: 'D' } },
        }),
      ).toBe(40);
      expect((await latest('D00'))!.timestamp).toEqual(new Date(T0 + 12 * MIN));
    });

    it('a move carries the latest row to the new farm', async () => {
      await store([{ turbineId: 'T1', at: T0 }]);
      await prisma.turbine.update({
        where: { turbineId: 'T1' },
        data: { farmId: 'FARM02' },
      });
      expect((await latest('T1'))!.farmId).toBe('FARM02');
      expect(
        (
          await prisma.telemetry.findFirstOrThrow({
            where: { turbineId: 'T1' },
          })
        ).farmId,
      ).toBe('FARM02');
    });

    it('importing held readings (assign / keep / move) updates it with the newest imported reading', async () => {
      const row = (minute: number, gearbox = 70) => ({
        turbineId: 'T9',
        farmId: 'FARM01',
        timestamp: new Date(T0 + minute * MIN),
        receivedAt: new Date(T0),
        powerOutputKw: 2000,
        windSpeedMs: 8,
        rotorRpm: 14,
        bladePitchDeg: 3,
        gearboxTempC: gearbox,
      });
      const entry = await prisma.$transaction(async (tx) => {
        const readings = [row(0), row(10, 130), row(5)];
        const kinds = await classifyReadings(tx, readings);
        expect(kinds).toEqual([
          'unknown_turbine',
          'unknown_turbine',
          'unknown_turbine',
        ]);
        const [e] = await holdReadings(
          tx,
          readings.map((r) => ({ ...r, kind: 'unknown_turbine' as const })),
        );
        return e;
      });
      expect(await latest('T9')).toBeNull(); // held, not in the fleet

      await prisma.$transaction(async (tx) => {
        await lockUnallocated(tx, entry.id);
        await tx.turbine.create({
          data: {
            turbineId: 'T9',
            farmId: 'FARM01',
            latitude: 1,
            longitude: 1,
          },
        });
        await importHeld(tx, entry.id, 'FARM01');
      });
      expect(await latest('T9')).toMatchObject({
        timestamp: new Date(T0 + 10 * MIN),
        worstAlertLevel: 'error',
      });
    });

    it('refreshTurbineLatest brings it in line with rows written around ingestion, newer only', async () => {
      await prisma.telemetry.createMany({
        data: [0, 5, 10].map((minute) => ({
          turbineId: 'T1',
          farmId: 'FARM01',
          timestamp: new Date(T0 + minute * MIN),
          powerOutputKw: minute,
          windSpeedMs: 8,
          rotorRpm: 14,
          bladePitchDeg: 3,
          gearboxTempC: 70,
        })),
      });
      await refreshTurbineLatest(prisma);
      expect(await latest('T1')).toMatchObject({
        timestamp: new Date(T0 + 10 * MIN),
        powerOutputKw: 10,
      });
      await refreshTurbineLatest(prisma, ['T1']); // idempotent
      expect(await prisma.turbineLatest.count()).toBe(1);
    });

    it('the CSV fixture seed fills it with each turbine’s newest CSV reading', async () => {
      await prisma.$executeRaw`TRUNCATE TABLE turbine_latest, farm_live_summary, anomaly_episodes, telemetry_alerts, telemetry, alerts_config, turbines`;
      await seedFromCsv(prisma, DATA_DIR);
      const rows = await prisma.turbineLatest.findMany({
        orderBy: { turbineId: 'asc' },
      });
      expect(rows.map((r) => r.turbineId)).toEqual(['TURB001', 'TURB002']);
      for (const r of rows) {
        const newest = await prisma.telemetry.findFirstOrThrow({
          where: { turbineId: r.turbineId },
          orderBy: { timestamp: 'desc' },
        });
        expect(r.timestamp).toEqual(newest.timestamp);
        expect(r.readingId).toBe(newest.id);
      }
    });
  });

  describe('partition maintenance', () => {
    const NOW = new Date('2026-11-03T12:00:00Z');
    beforeEach(reset);

    /** Rows with alerts on a given number of days before NOW. */
    const daysAgo = (n: number, minute = 0) =>
      NOW.getTime() - n * DAY + minute * MIN;
    const part = async (table: 'telemetry' | 'telemetry_alerts') =>
      Object.fromEntries(
        (
          await m.db.query<{ part: string; n: number }>(
            `SELECT tableoid::regclass::text AS part, count(*)::int AS n FROM ${table} GROUP BY 1`,
          )
        ).rows.map((r) => [r.part, r.n]),
      );
    const count = async (table: string) =>
      (
        await m.db.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM ${table}`,
        )
      ).rows[0].n;

    /** Hot readings (an error alert each) on days 1, 5, 20 and 60 before NOW, plus quiet ones. */
    const fill = async () => {
      await store(
        [60, 20, 5, 1].flatMap((d) => [
          { turbineId: 'T1', at: daysAgo(d), gearbox: 130 },
          { turbineId: 'T1', at: daysAgo(d, 5) },
        ]),
      );
    };

    it('creates the days ahead, moves recent DEFAULT rows into daily partitions, keeps older ones, deletes nothing', async () => {
      await fill();
      const readings = await count('telemetry');
      const alerts = await count('telemetry_alerts');
      // Everything is in DEFAULT except what already has a partition (none for Oct 2026).
      expect((await part('telemetry')).telemetry_default).toBe(readings);

      const result = await runPartitionMaintenance(prisma, { now: NOW });
      expect(result).toMatchObject({
        dropped: 0,
        purgedDefault: 0,
        retentionCutoff: null,
      });
      expect(result.created).toEqual(
        // The carved days, and today and tomorrow (the migration already made the real days ahead).
        expect.arrayContaining([
          '2026-11-02',
          '2026-10-29',
          '2026-10-14',
          '2026-11-03',
        ]),
      );

      // Days within 31 days moved with their alerts; the 60-day-old day stays in DEFAULT.
      expect(await part('telemetry')).toMatchObject({
        telemetry_p20261102: 2,
        telemetry_p20261029: 2,
        telemetry_p20261014: 2,
        telemetry_default: 2,
      });
      expect(await part('telemetry_alerts')).toMatchObject({
        telemetry_alerts_p20261102: 1,
        telemetry_alerts_p20261029: 1,
        telemetry_alerts_p20261014: 1,
        telemetry_alerts_default: 1,
      });
      expect(await count('telemetry')).toBe(readings);
      expect(await count('telemetry_alerts')).toBe(alerts);

      // A second run creates nothing and moves nothing.
      expect(
        (await runPartitionMaintenance(prisma, { now: NOW })).created,
      ).toEqual([]);
    });

    it('overlapping runs do not error: one holding the lock makes the other skip, and the lock is released after', async () => {
      // Deterministic: a "running" maintenance is simulated by holding its lock.
      let release!: () => void;
      let held!: () => void;
      const heldP = new Promise<void>((r) => (held = r));
      const holder = prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${PARTITION_MAINTENANCE_LOCK}, 0))`;
          held();
          await new Promise<void>((r) => (release = r));
        },
        { timeout: 60_000 },
      );
      await heldP;
      const skipped = await Promise.all([
        runPartitionMaintenance(prisma, { now: NOW }),
        runPartitionMaintenance(prisma, { now: NOW, retentionDays: 10 }),
      ]);
      expect(skipped.map((r) => r.skipped)).toEqual([true, true]);
      expect(skipped.every((r) => r.created.length === 0)).toBe(true);
      release();
      await holder;

      // Free again; two truly concurrent runs both resolve (no duplicate-partition error).
      const both = await Promise.all([
        runPartitionMaintenance(prisma, { now: NOW }),
        runPartitionMaintenance(prisma, { now: NOW }),
      ]);
      expect(both.some((r) => !r.skipped)).toBe(true);
      expect(
        (await runPartitionMaintenance(prisma, { now: NOW })).skipped,
      ).toBe(false);
    });

    it('creating a day’s partition moves its rows out of DEFAULT (seed fixtures, CSV backfills)', async () => {
      await store([{ turbineId: 'T1', at: daysAgo(2), gearbox: 130 }]);
      expect((await part('telemetry')).telemetry_default).toBe(1);
      await expect(
        ensureTelemetryPartition(prisma, '2026-11-01'),
      ).resolves.toBe(true);
      expect(await part('telemetry')).toEqual({ telemetry_p20261101: 1 });
      expect(await part('telemetry_alerts')).toEqual({
        telemetry_alerts_p20261101: 1,
      });
      // Another reading of that day now goes straight into the partition.
      await store([{ turbineId: 'T1', at: daysAgo(2, 10) }]);
      expect(await part('telemetry')).toEqual({ telemetry_p20261101: 2 });
    });

    it('with a retention: drops old days with their alerts and purges older DEFAULT rows; nothing else is lost', async () => {
      await fill();
      await runPartitionMaintenance(prisma, { now: NOW }); // carve the recent days first
      const result = await runPartitionMaintenance(prisma, {
        now: NOW,
        retentionDays: 10,
      });

      // Day 20's partition dropped (older than 10 days); the 60-day-old DEFAULT rows purged.
      expect(result).toMatchObject({ dropped: 1, purgedDefault: 2 });
      expect(await count('telemetry')).toBe(4);
      expect(await count('telemetry_alerts')).toBe(2);
      expect(await part('telemetry')).toMatchObject({
        telemetry_p20261029: 2,
        telemetry_p20261102: 2,
      });
      expect(await part('telemetry')).not.toHaveProperty('telemetry_default');
      // No orphans, and the rules, turbines and farms are untouched.
      expect(
        await count(
          `telemetry_alerts a WHERE NOT EXISTS (SELECT 1 FROM telemetry t WHERE t.id = a.telemetry_id AND t."timestamp" = a.reading_timestamp)`,
        ),
      ).toBe(0);
      expect(await count('alerts_config')).toBe(2);
      expect(await count('turbines')).toBe(4);
      // turbine_latest is not a retention victim: it still points at the newest reading.
      expect((await latest('T1'))!.timestamp).toEqual(new Date(daysAgo(1, 5)));
    });

    const latest = (turbineId: string) =>
      prisma.turbineLatest.findUnique({ where: { turbineId } });

    /** Relations a plan scans (partitions of telemetry). */
    const scanned = async (sql: string): Promise<string[]> => {
      const { rows } = await m.db.query(`EXPLAIN (FORMAT JSON) ${sql}`);
      const found = new Set<string>();
      const walk = (node: Record<string, unknown>) => {
        if (typeof node['Relation Name'] === 'string')
          found.add(node['Relation Name']);
        for (const child of (node.Plans as
          Record<string, unknown>[] | undefined) ?? [])
          walk(child);
      };
      walk(rows[0]['QUERY PLAN'][0].Plan);
      return [...found].sort();
    };

    it('time-range queries and the farm rollup’s per-farm scan prune to the partitions of their range', async () => {
      await fill();
      await runPartitionMaintenance(prisma, { now: NOW });

      expect(
        await scanned(
          `SELECT * FROM telemetry WHERE "timestamp" >= '2026-11-02T00:00:00Z' AND "timestamp" < '2026-11-03T00:00:00Z'`,
        ),
      ).toEqual(['telemetry_p20261102']);
      // A multi-day range over a contiguous run of partitions: exactly those, DEFAULT excluded.
      for (const day of ['2026-10-30', '2026-10-31', '2026-11-01']) {
        await ensureTelemetryPartition(prisma, day);
      }
      expect(
        await scanned(
          `SELECT * FROM telemetry WHERE "timestamp" >= '2026-10-29T00:00:00Z' AND "timestamp" < '2026-11-03T00:00:00Z'`,
        ),
      ).toEqual([
        'telemetry_p20261029',
        'telemetry_p20261030',
        'telemetry_p20261031',
        'telemetry_p20261101',
        'telemetry_p20261102',
      ]);
      // The rollup's recompute of one farm from a bucket on: only the partitions from there.
      const rollup = await scanned(
        `SELECT t.turbine_id FROM telemetry t WHERE t.farm_id = 'FARM01' AND t."timestamp" >= '2026-11-03T00:00:00Z'`,
      );
      expect(rollup).not.toContain('telemetry_p20261102');
      expect(
        rollup.every(
          (r) => r >= 'telemetry_p20261103' || r === 'telemetry_default',
        ),
      ).toBe(true);
      // The alerts' list for a day touches that day's alerts partition (and joins by id+timestamp).
      expect(
        await scanned(
          `SELECT * FROM telemetry_alerts WHERE reading_timestamp >= '2026-11-02T00:00:00Z' AND reading_timestamp < '2026-11-03T00:00:00Z'`,
        ),
      ).toEqual(['telemetry_alerts_p20261102']);
    });
  });

  describe('live summary', () => {
    beforeEach(reset);
    const NOW = new Date('2026-11-03T12:00:00Z');

    it('counts reporting, stale and silent turbines per farm and sums power / averages wind of the reporting ones', async () => {
      await store([
        { turbineId: 'T1', at: NOW.getTime() - 5 * MIN, power: 1000, wind: 6 },
        {
          turbineId: 'T2',
          at: NOW.getTime() - 15 * MIN,
          power: 500,
          wind: 10,
          gearbox: 130,
        }, // exactly 15: reporting
        { turbineId: 'T4', at: NOW.getTime() - 16 * MIN, power: 700 }, // stale
      ]);
      await store([{ turbineId: 'T4', at: NOW.getTime() - 40 * MIN }]); // older: ignored by latest
      // T3 never reported.

      await expect(runLiveSummary(prisma, { now: NOW })).resolves.toMatchObject(
        { farms: 10 },
      );

      const farm1 = await prisma.farmLiveSummary.findUniqueOrThrow({
        where: { farmId: 'FARM01' },
      });
      expect(farm1).toMatchObject({
        turbines: 3,
        commissioned: 2, // T2 is not commissioned
        reporting: 2,
        stale: 0,
        alerting: 1, // T2's error
        powerOutputKw: 1500,
        windSpeedMs: 8,
        asOf: NOW,
      });
      const farm2 = await prisma.farmLiveSummary.findUniqueOrThrow({
        where: { farmId: 'FARM02' },
      });
      expect(farm2).toMatchObject({
        turbines: 1,
        reporting: 0,
        stale: 1,
        powerOutputKw: 0,
        windSpeedMs: null,
      });
      // A farm without turbines still has a row.
      expect(
        await prisma.farmLiveSummary.findUniqueOrThrow({
          where: { farmId: 'FARM03' },
        }),
      ).toMatchObject({
        turbines: 0,
        reporting: 0,
      });

      // Idempotent, and it follows a move and later readings.
      await prisma.turbine.update({
        where: { turbineId: 'T1' },
        data: { farmId: 'FARM02' },
      });
      await store([
        { turbineId: 'T4', at: NOW.getTime() - MIN, power: 300, wind: 4 },
      ]);
      await runLiveSummary(prisma, { now: NOW });
      await runLiveSummary(prisma, { now: NOW });
      expect(await prisma.farmLiveSummary.count()).toBe(10);
      expect(
        await prisma.farmLiveSummary.findUniqueOrThrow({
          where: { farmId: 'FARM02' },
        }),
      ).toMatchObject({
        turbines: 2,
        reporting: 2,
        powerOutputKw: 1300,
        windSpeedMs: 5,
      });
    });
  });

  describe('anomaly rollup', () => {
    beforeEach(reset);
    const B = Date.UTC(2026, 10, 3, 0, 0);

    const episodes = () =>
      prisma.anomalyEpisode.findMany({
        orderBy: [
          { turbineId: 'asc' },
          { kind: 'asc' },
          { episodeStart: 'asc' },
        ],
      });

    it('keeps a long stuck sensor one episode across incremental runs, and is idempotent', async () => {
      const stuck = (from: number, to: number): Reading[] =>
        Array.from({ length: to - from }, (_, i) => ({
          turbineId: 'T1',
          at: B + (from + i) * 5 * MIN,
          gearbox: 77.7, // stuck
          wind: 6 + ((from + i) % 7) * 0.3, // the other sensors keep changing
          rpm: 10 + ((from + i) % 5),
          power: 1000 + 100 * (from + i),
        }));
      // A short low-power episode of T2 that ends early and must stay untouched afterwards.
      const lowT2: Reading[] = [0, 1, 2, 3].map((i) => ({
        turbineId: 'T2',
        at: B + i * 5 * MIN,
        wind: 12,
        power: 10,
      }));

      await store([...stuck(0, 14), ...lowT2]);
      const first = await runAnomalyRollup(prisma, {
        now: new Date(B + 70 * MIN),
      });
      expect(first).toMatchObject({ skipped: false, written: 2 });
      const early = await episodes();
      expect(
        early.map((e) => [e.turbineId, e.kind, e.metric, e.readings]),
      ).toEqual([
        ['T1', 'stuck_sensor', 'gearboxTempC', 14],
        ['T2', 'low_power_in_wind', null, 4],
      ]);

      await store(stuck(14, 20));
      // A short lookback puts the window start (B + 40 min) inside the episode, which was still
      // open (it ended at B + 65 min): it restarts from its own first reading.
      const second = await runAnomalyRollup(prisma, {
        now: new Date(B + 100 * MIN),
        lookbackMinutes: 30,
      });
      expect(second.reopened).toBe(1);
      const later = await episodes();
      expect(
        later.map((e) => [
          e.turbineId,
          e.kind,
          e.readings,
          e.episodeStart.getTime(),
          e.episodeEnd.getTime(),
        ]),
      ).toEqual([
        ['T1', 'stuck_sensor', 20, B, B + 95 * MIN], // one episode, not two
        ['T2', 'low_power_in_wind', 4, B, B + 15 * MIN],
      ]);

      // Same inputs, same table.
      const strip = (rows: typeof later) =>
        rows.map(({ id: _id, computedAt: _c, ...rest }) => rest);
      await runAnomalyRollup(prisma, {
        now: new Date(B + 100 * MIN),
        lookbackMinutes: 30,
      });
      expect(strip(await episodes())).toEqual(strip(later));
      expect(
        (
          await prisma.anomalyRollupState.findUniqueOrThrow({
            where: { id: 1 },
          })
        ).asOf,
      ).toEqual(new Date(B + 100 * MIN));
    });

    it('recomputes a late reading inside the lookback window', async () => {
      const row = (i: number): Reading => ({
        turbineId: 'T1',
        at: B + i * 5 * MIN,
        wind: 12,
        power: 10,
      });
      await store([row(0), row(1), row(3), row(4)]); // a hole at 2: two runs of 2 → no episode
      await runAnomalyRollup(prisma, { now: new Date(B + 30 * MIN) });
      expect(await prisma.anomalyEpisode.count()).toBe(0);

      await store([row(2)]); // arrives late, with the older timestamp
      await runAnomalyRollup(prisma, { now: new Date(B + 60 * MIN) });
      expect(await episodes()).toMatchObject([
        { turbineId: 'T1', kind: 'low_power_in_wind', readings: 5 },
      ]);
    });

    it('finds the same episodes as listAnomalies over the demo fleet, in any chunking', async () => {
      await prisma.$executeRaw`TRUNCATE TABLE turbine_latest, farm_live_summary, anomaly_episodes, anomaly_expected_power, anomaly_rollup_state, telemetry_alerts, telemetry, held_telemetry, unallocated_turbines, alerts_config, turbines`;
      const end = new Date('2026-10-08T12:00:00Z');
      await seedDemo(prisma, { dataDir: DATA_DIR, end, hours: 72 });
      const from = new Date(end.getTime() - 73 * HOUR);
      const to = new Date(end.getTime() + HOUR);

      const onRead = (
        await listAnomalies(prisma, {
          from: from.toISOString(),
          to: to.toISOString(),
        })
      ).anomalies;
      expect(onRead.length).toBeGreaterThanOrEqual(2); // the frozen TURB001 and the stuck TURB002 gearbox

      const stored = async () => {
        const rows: AnomalyRow[] = (await episodes()).map((e) => ({
          kind: e.kind as AnomalyRow['kind'],
          metric: e.metric as AnomalyRow['metric'],
          turbine_id: e.turbineId,
          farm_id: e.farmId,
          episode_start: e.episodeStart,
          episode_end: e.episodeEnd,
          readings: e.readings,
          value: e.value,
          wind_speed_ms: e.windSpeedMs,
          lost_kwh: e.lostKwh,
        }));
        return toAnomaliesResponse(from, to, rows).anomalies;
      };
      const key = (a: {
        end: string;
        turbineId: string;
        kind: string;
        metric: string | null;
      }) => `${a.end}|${a.turbineId}|${a.kind}|${a.metric}`;
      const sorted = <T extends Parameters<typeof key>[0]>(list: T[]) =>
        [...list].sort((a, b) => key(b).localeCompare(key(a)));

      for (const chunkTurbines of [20_000, 37]) {
        await prisma.$executeRaw`TRUNCATE TABLE anomaly_episodes, anomaly_expected_power, anomaly_rollup_state`;
        await runAnomalyRollup(prisma, {
          mode: { kind: 'from', day: from.toISOString().slice(0, 10) },
          now: to,
          calibrationHours: 120, // the same readings listAnomalies derives its bins from
          chunkTurbines,
        });
        expect(sorted(await stored())).toEqual(sorted(onRead));
      }
    });
  });
});
