import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { seedFarmsFromCsv } from '../src/seed/seed-from-csv.js';
import {
  FARM_ROLLUP_LOCK,
  FARM_ROLLUP_LOOKBACK_MS,
  runFarmRollup,
  type FarmRollupClient,
} from '../src/wind/farm-rollup.js';
import { farmDailyHistory } from '../src/wind/queries.js';
import { openMigrationDb, type MigrationDb } from './migration-db.js';

const DATA_DIR = fileURLToPath(new URL('../prisma/data', import.meta.url));
const NOW = new Date('2026-11-03T12:00:00Z');
const MIN = 60_000;
/** created_at well before any run, so the incremental scan's lookback doesn't see these rows. */
const longAgo = () => new Date(Date.now() - 60 * MIN);

interface Reading {
  turbineId: string;
  farmId?: string;
  at: string | number;
  power: number;
  wind?: number;
  rpm?: number;
  pitch?: number;
  gearbox?: number;
}

/**
 * The farm rollup (runFarmRollup) and the daily read (farmDailyHistory) against a real Postgres:
 * the farm series (sum vs means), OHLC per bucket and per local day, the incremental watermark,
 * dirty markers from a move, idempotency, the lock, a failed run, and pruning.
 */
describe('farm rollup (e2e)', () => {
  let m: MigrationDb;
  let prisma: PrismaClient;

  beforeAll(async () => {
    m = await openMigrationDb('99999999999999_farm_rollup');
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

  beforeEach(async () => {
    await prisma.$executeRaw`TRUNCATE TABLE turbine_latest, telemetry_alerts, telemetry, farm_telemetry_rollups, farm_rollup_state, farm_rollup_dirty`;
    await prisma.turbine.deleteMany();
    await prisma.turbine.createMany({
      data: [
        { turbineId: 'T1', farmId: 'FARM01', latitude: 41, longitude: -96 },
        { turbineId: 'T2', farmId: 'FARM01', latitude: 41, longitude: -96 },
        { turbineId: 'T3', farmId: 'FARM02', latitude: 42, longitude: -97 },
      ],
    });
  });

  const insert = (readings: Reading[], createdAt?: Date) =>
    prisma.telemetry.createMany({
      data: readings.map((r) => ({
        turbineId: r.turbineId,
        farmId: r.farmId ?? (r.turbineId === 'T3' ? 'FARM02' : 'FARM01'),
        timestamp: new Date(r.at),
        powerOutputKw: r.power,
        windSpeedMs: r.wind ?? 8,
        rotorRpm: r.rpm ?? 14,
        bladePitchDeg: r.pitch ?? 3,
        gearboxTempC: r.gearbox ?? 80,
        ...(createdAt && { createdAt }),
      })),
    });

  /** One reading per `stepMin` minutes in [from, to), power = minutes since `from`. */
  const series = (
    turbineId: string,
    from: string,
    to: string,
    stepMin = 30,
  ): Reading[] => {
    const out: Reading[] = [];
    for (let t = Date.parse(from); t < Date.parse(to); t += stepMin * MIN) {
      out.push({ turbineId, at: t, power: (t - Date.parse(from)) / MIN });
    }
    return out;
  };

  const rollups = (farmId = 'FARM01') =>
    prisma.farmTelemetryRollup.findMany({
      where: { farmId },
      orderBy: { bucketStart: 'asc' },
    });

  const daily = (farmId: string, from: string, to: string, timeZone?: string) =>
    farmDailyHistory(prisma, farmId, { from, to, timeZone });

  it('sums power and averages the other metrics per timestamp; OHLC of that series per bucket', async () => {
    await insert([
      {
        turbineId: 'T1',
        at: '2026-11-02T00:00:00Z',
        power: 1000,
        wind: 8,
        gearbox: 70,
      },
      {
        turbineId: 'T2',
        at: '2026-11-02T00:00:00Z',
        power: 2000,
        wind: 10,
        gearbox: 90,
      },
      {
        turbineId: 'T1',
        at: '2026-11-02T00:05:00Z',
        power: 1500,
        wind: 9,
        gearbox: 100,
      },
      {
        turbineId: 'T1',
        at: '2026-11-02T00:10:00Z',
        power: 500,
        wind: 4,
        gearbox: 60,
      },
      {
        turbineId: 'T2',
        at: '2026-11-02T00:10:00Z',
        power: 700,
        wind: 6,
        gearbox: 62,
      },
      { turbineId: 'T1', at: '2026-11-02T00:30:00Z', power: 42, wind: 3 }, // next bucket
      { turbineId: 'T3', at: '2026-11-02T00:00:00Z', power: 5000 }, // another farm
    ]);

    const result = await runFarmRollup(prisma, { now: NOW });

    expect(result).toMatchObject({
      skipped: false,
      firstRun: true,
      written: 3,
    });
    const [first, second] = await rollups();
    expect(first).toMatchObject({
      bucketStart: new Date('2026-11-02T00:00:00Z'),
      readings: 5,
      turbines: 2,
      // power: 3000 (sum), 1500 (T1 only), 1200
      powerOpen: 3000,
      powerClose: 1200,
      powerHigh: 3000,
      powerLow: 1200,
      // wind: 9 (mean), 9, 5
      windSpeedOpen: 9,
      windSpeedClose: 5,
      windSpeedHigh: 9,
      windSpeedLow: 5,
      // gearbox: 80, 100, 61
      gearboxTempOpen: 80,
      gearboxTempClose: 61,
      gearboxTempHigh: 100,
      gearboxTempLow: 61,
    });
    expect(second).toMatchObject({
      bucketStart: new Date('2026-11-02T00:30:00Z'),
      readings: 1,
      turbines: 1,
      powerOpen: 42,
      powerClose: 42,
    });
    expect((await rollups('FARM02'))[0]).toMatchObject({
      readings: 1,
      powerOpen: 5000,
    });
  });

  it('builds local days from the buckets: UTC, America/Chicago (a 25-hour DST day) and Asia/Kolkata (+5:30)', async () => {
    // Every 30 minutes from 2026-10-31 to 2026-11-03 UTC; power = minutes since the start.
    await insert(series('T1', '2026-10-31T00:00:00Z', '2026-11-03T00:00:00Z'));
    await runFarmRollup(prisma, { now: NOW });

    const utc = await daily(
      'FARM01',
      '2026-11-01T00:00:00Z',
      '2026-11-02T00:00:00Z',
    );
    expect(utc).toMatchObject({ timeZone: 'UTC', turbineCount: 2 });
    expect(utc.days).toEqual([
      {
        date: '2026-11-01',
        turbines: 1,
        readings: 48,
        powerOutputKw: { open: 1440, close: 2850, high: 2850, low: 1440 },
        windSpeedMs: { open: 8, close: 8, high: 8, low: 8 },
        rotorRpm: { open: 14, close: 14, high: 14, low: 14 },
        bladePitchDeg: { open: 3, close: 3, high: 3, low: 3 },
        gearboxTempC: { open: 80, close: 80, high: 80, low: 80 },
      },
    ]);

    // Chicago falls back on 2026-11-01: CDT midnight is 05:00Z, the next CST midnight 06:00Z.
    const chicago = await daily(
      'FARM01',
      '2026-11-01T05:00:00Z',
      '2026-11-02T06:00:00Z',
      'America/Chicago',
    );
    expect(chicago.days).toHaveLength(1);
    expect(chicago.days[0]).toMatchObject({
      date: '2026-11-01',
      readings: 50, // 25 hours
      powerOutputKw: { open: 1740, close: 3210 }, // 05:00Z, 05:30Z next day
    });

    // Kolkata: 2026-11-01 runs from 2026-10-31T18:30Z to 2026-11-01T18:30Z.
    const kolkata = await daily(
      'FARM01',
      '2026-10-31T18:30:00Z',
      '2026-11-02T18:30:00Z',
      'Asia/Kolkata',
    );
    expect(kolkata.days.map((d) => [d.date, d.readings])).toEqual([
      ['2026-11-01', 48],
      ['2026-11-02', 48],
    ]);
    expect(kolkata.days[0].powerOutputKw).toEqual({
      open: 1110, // 18:30Z
      close: 2520, // 18:00Z next day
      high: 2520,
      low: 1110,
    });
    expect(kolkata.computedAt).toEqual(expect.any(String));
  });

  it('a day takes the most turbines in any bucket, and omits days without readings', async () => {
    await insert([
      { turbineId: 'T1', at: '2026-11-01T01:00:00Z', power: 1 },
      { turbineId: 'T1', at: '2026-11-01T02:00:00Z', power: 1 },
      { turbineId: 'T2', at: '2026-11-01T02:05:00Z', power: 1 },
      { turbineId: 'T1', at: '2026-11-03T02:00:00Z', power: 1 },
    ]);
    await runFarmRollup(prisma, { now: NOW });

    const result = await daily(
      'FARM01',
      '2026-11-01T00:00:00Z',
      '2026-11-04T00:00:00Z',
    );
    expect(result.days.map((d) => [d.date, d.turbines, d.readings])).toEqual([
      ['2026-11-01', 2, 3],
      ['2026-11-03', 1, 1],
    ]);
  });

  it('is idempotent: a second run over the same data writes the same rows', async () => {
    await insert(
      series('T1', '2026-11-02T00:00:00Z', '2026-11-03T00:00:00Z', 5),
    );
    await runFarmRollup(prisma, { now: NOW });
    const before = await rollups();

    const again = await runFarmRollup(prisma, {
      mode: { kind: 'full' },
      now: NOW,
    });

    expect(again.written).toBe(before.length);
    const after = await rollups();
    const values = (rows: typeof before) =>
      rows.map((r) => ({ ...r, computedAt: null }));
    expect(values(after)).toEqual(values(before));
    expect(after[0].computedAt.toISOString()).toBe(again.watermark);
  });

  it('incremental: recomputes from a late reading’s bucket and the current day, leaving older buckets alone', async () => {
    await insert(
      series('T1', '2026-10-28T00:00:00Z', '2026-11-03T12:00:00Z'),
      longAgo(),
    );
    await insert(
      series('T3', '2026-10-28T00:00:00Z', '2026-11-03T12:00:00Z'),
      longAgo(),
    );
    const first = await runFarmRollup(prisma, { now: NOW });
    const state = await prisma.farmRollupState.findUniqueOrThrow({
      where: { id: 1 },
    });
    expect(state.watermark.toISOString()).toBe(first.watermark);
    const computedAt = async (farmId: string, at: string) =>
      (
        await prisma.farmTelemetryRollup.findUniqueOrThrow({
          where: { farmId_bucketStart: { farmId, bucketStart: new Date(at) } },
        })
      ).computedAt.toISOString();
    const oldBucket = await computedAt('FARM01', '2026-10-29T10:00:00Z');

    // A late reading for 2026-10-30 10:07 (T2, so the bucket gains a turbine).
    await insert([
      { turbineId: 'T2', at: '2026-10-30T10:07:00Z', power: 10_000 },
    ]);
    const second = await runFarmRollup(prisma, { now: NOW });

    expect(second).toMatchObject({
      firstRun: false,
      farms: 10, // the current day of every farm
      from: '2026-10-30T10:00:00.000Z',
    });
    const late = await prisma.farmTelemetryRollup.findUniqueOrThrow({
      where: {
        farmId_bucketStart: {
          farmId: 'FARM01',
          bucketStart: new Date('2026-10-30T10:00:00Z'),
        },
      },
    });
    expect(late).toMatchObject({ turbines: 2, readings: 2, powerHigh: 10_000 });
    expect(late.computedAt.toISOString()).toBe(second.watermark);
    // Before the late reading's bucket: untouched. FARM02 only from the current UTC day.
    expect(await computedAt('FARM01', '2026-10-29T10:00:00Z')).toBe(oldBucket);
    expect(await computedAt('FARM02', '2026-11-02T23:30:00Z')).toBe(
      first.watermark,
    );
    expect(await computedAt('FARM02', '2026-11-03T00:00:00Z')).toBe(
      second.watermark,
    );
  });

  it('incremental: also catches a row whose transaction began before the watermark (lookback)', async () => {
    await insert(series('T1', '2026-11-02T00:00:00Z', '2026-11-02T06:00:00Z'));
    const first = await runFarmRollup(prisma, { now: NOW });
    // created_at is the inserting transaction's start: one that committed after the run started
    // carries an older created_at.
    await insert(
      [{ turbineId: 'T2', at: '2026-11-01T03:00:00Z', power: 7 }],
      new Date(Date.parse(first.watermark!) - FARM_ROLLUP_LOOKBACK_MS / 2),
    );

    await runFarmRollup(prisma, { now: NOW });

    expect(
      (await daily('FARM01', '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z'))
        .days,
    ).toMatchObject([{ date: '2026-11-01', readings: 1 }]);
  });

  it('a move (UPDATE turbines SET farm_id) marks both farms dirty in its transaction; the next run moves the history', async () => {
    await insert(series('T1', '2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z'));
    await insert(series('T3', '2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z'));
    await runFarmRollup(prisma, { now: NOW });
    const day = ['2026-10-20T00:00:00Z', '2026-10-21T00:00:00Z'] as const;
    expect((await daily('FARM01', ...day)).days[0].readings).toBe(48);

    // Nothing reaches telemetry.created_at: only the cascade rewrites telemetry.farm_id.
    await prisma.turbine.update({
      where: { turbineId: 'T1' },
      data: { farmId: 'FARM02' },
    });
    // An update that keeps the farm marks nothing.
    await prisma.turbine.update({
      where: { turbineId: 'T3' },
      data: { commissioned: true },
    });

    const markers = await prisma.farmRollupDirty.findMany({
      orderBy: { farmId: 'asc' },
    });
    expect(markers.map((d) => [d.farmId, d.fromTime.toISOString()])).toEqual([
      ['FARM01', '2026-10-20T00:00:00.000Z'],
      ['FARM02', '2026-10-20T00:00:00.000Z'],
    ]);

    const result = await runFarmRollup(prisma, { now: NOW });

    expect(result).toMatchObject({
      dirty: 2,
      from: '2026-10-20T00:00:00.000Z',
    });
    expect(await prisma.farmRollupDirty.count()).toBe(0);
    expect((await daily('FARM01', ...day)).days).toEqual([]);
    expect((await daily('FARM02', ...day)).days[0]).toMatchObject({
      turbines: 2,
      readings: 96,
      powerOutputKw: { open: 0, close: 2 * 1410 },
    });
  });

  it('a turbine without readings moves without a marker', async () => {
    await prisma.turbine.update({
      where: { turbineId: 'T2' },
      data: { farmId: 'FARM03' },
    });
    expect(await prisma.farmRollupDirty.count()).toBe(0);
  });

  it('skips while another run holds the lock, changing nothing', async () => {
    await insert(series('T1', '2026-11-02T00:00:00Z', '2026-11-02T06:00:00Z'));
    const other = new pg.Client({ connectionString: m.url });
    await other.connect();
    try {
      await other.query('BEGIN');
      await other.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [FARM_ROLLUP_LOCK],
      );

      const result = await runFarmRollup(prisma, { now: NOW });

      expect(result).toMatchObject({
        skipped: true,
        written: 0,
        watermark: null,
      });
      expect(await prisma.farmTelemetryRollup.count()).toBe(0);
      expect(await prisma.farmRollupState.count()).toBe(0);
    } finally {
      await other.query('ROLLBACK');
      await other.end();
    }
    expect((await runFarmRollup(prisma, { now: NOW })).skipped).toBe(false);
  });

  it('a failed run rolls back: rollups, consumed markers and the watermark stay as they were', async () => {
    await insert(series('T1', '2026-11-02T00:00:00Z', '2026-11-02T06:00:00Z'));
    const first = await runFarmRollup(prisma, { now: NOW });
    await insert([{ turbineId: 'T1', at: '2026-11-01T00:00:00Z', power: 1 }]);
    await prisma.turbine.update({
      where: { turbineId: 'T1' },
      data: { farmId: 'FARM02' },
    });
    const rowsBefore = await prisma.farmTelemetryRollup.count();

    // Fails at the very end, when the watermark is saved.
    const failing: FarmRollupClient = {
      $transaction: ((
        fn: (tx: unknown) => Promise<unknown>,
        options: unknown,
      ) =>
        prisma.$transaction(
          (tx) =>
            fn(
              new Proxy(tx, {
                get: (target, key) =>
                  key === 'farmRollupState'
                    ? {
                        findUnique: target.farmRollupState.findUnique.bind(
                          target.farmRollupState,
                        ),
                        upsert: () =>
                          Promise.reject(new Error('connection lost')),
                      }
                    : Reflect.get(target, key),
              }),
            ),
          options as never,
        )) as FarmRollupClient['$transaction'],
    };
    await expect(runFarmRollup(failing, { now: NOW })).rejects.toThrow(
      'connection lost',
    );

    const state = await prisma.farmRollupState.findUniqueOrThrow({
      where: { id: 1 },
    });
    expect(state.watermark.toISOString()).toBe(first.watermark);
    expect(await prisma.farmRollupDirty.count()).toBe(2);
    expect(await prisma.farmTelemetryRollup.count()).toBe(rowsBefore);
    expect(
      await prisma.farmTelemetryRollup.count({ where: { farmId: 'FARM02' } }),
    ).toBe(0);

    // The next run catches up.
    const next = await runFarmRollup(prisma, { now: NOW });
    expect(next).toMatchObject({ dirty: 2 });
    expect(
      await prisma.farmTelemetryRollup.count({ where: { farmId: 'FARM01' } }),
    ).toBe(0);
    expect(
      (await daily('FARM02', '2026-11-01T00:00:00Z', '2026-11-03T00:00:00Z'))
        .days,
    ).toMatchObject([
      { date: '2026-11-01', readings: 1 },
      { date: '2026-11-02', readings: 12 },
    ]);
  });

  it('prunes rows older than 190 days before the newest reading, and never recomputes them', async () => {
    await insert([
      { turbineId: 'T1', at: '2026-04-01T00:00:00Z', power: 1 }, // > 190 days before NOW
      { turbineId: 'T1', at: '2026-05-01T00:00:00Z', power: 1 }, // inside
      { turbineId: 'T1', at: '2026-11-03T11:00:00Z', power: 1 },
    ]);
    // A leftover row from an earlier run.
    await prisma.farmTelemetryRollup.create({
      data: {
        farmId: 'FARM02',
        bucketStart: new Date('2026-03-01T00:00:00Z'),
        readings: 1,
        turbines: 1,
        ...Object.fromEntries(
          [
            'power',
            'windSpeed',
            'rotorRpm',
            'bladePitch',
            'gearboxTemp',
          ].flatMap((p) =>
            ['Open', 'Close', 'High', 'Low'].map((s) => [`${p}${s}`, 1]),
          ),
        ),
      } as never,
    });

    const result = await runFarmRollup(prisma, { now: NOW });

    expect(result).toMatchObject({
      pruned: 1,
      cutoff: '2026-04-27T11:00:00.000Z',
    });
    expect((await rollups()).map((r) => r.bucketStart.toISOString())).toEqual([
      '2026-05-01T00:00:00.000Z',
      '2026-11-03T11:00:00.000Z',
    ]);
  });

  it('ignores new readings older than the cutoff: they would only force a recompute from it', async () => {
    await insert(
      series('T1', '2026-11-02T00:00:00Z', '2026-11-03T12:00:00Z'),
      longAgo(),
    );
    await runFarmRollup(prisma, { now: NOW });
    await insert([{ turbineId: 'T1', at: '2026-01-01T00:00:00Z', power: 1 }]); // a backfill

    const result = await runFarmRollup(prisma, { now: NOW });

    expect(result.from).toBe('2026-11-03T00:00:00.000Z'); // only the current day
  });

  it('anchors the retention on the newest reading, so a dataset that ended long ago keeps its history', async () => {
    await insert(series('T1', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'));

    const result = await runFarmRollup(prisma, { now: NOW });

    expect(result.cutoff).toBe('2025-06-25T23:30:00.000Z');
    expect(await prisma.farmTelemetryRollup.count()).toBe(48);
  });

  it('--from recomputes every farm from that UTC day', async () => {
    await insert(
      series('T1', '2026-10-25T00:00:00Z', '2026-10-27T00:00:00Z'),
      longAgo(),
    );
    await insert(
      series('T3', '2026-10-25T00:00:00Z', '2026-10-27T00:00:00Z'),
      longAgo(),
    );
    await runFarmRollup(prisma, { now: NOW });

    const result = await runFarmRollup(prisma, {
      mode: { kind: 'from', day: '2026-10-26' },
      now: NOW,
    });

    expect(result).toMatchObject({
      farms: 10,
      from: '2026-10-26T00:00:00.000Z',
      written: 96,
      deleted: 96,
    });
  });
});
