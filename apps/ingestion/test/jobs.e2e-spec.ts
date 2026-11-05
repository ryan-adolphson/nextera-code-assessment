import { runJobCli } from '../src/job-runner.js';
import { anomalyRollupJob } from '../src/anomaly-rollup/anomaly-rollup.js';
import { liveSummaryJob } from '../src/live-summary/live-summary.js';
import { partitionMaintenanceJob } from '../src/partition-maintenance/partition-maintenance.js';
import { createTestApp, type TestApp } from './helpers.js';

const HEADER =
  'turbine_id,farm_id,timestamp,received_at,power_output_kw,wind_speed_ms,rotor_rpm,blade_pitch_deg,gearbox_temp_c';
const DAY = 24 * 3_600_000;

/**
 * The three maintenance jobs as the images run them (`runJobCli` with their definitions) against
 * the worker's database and Redis: partition maintenance (no retention keeps everything, a
 * retention deletes old DEFAULT rows from a CSV backfill), the live summary (+ fleet.tick on the
 * stream) and the anomaly rollup on the provided CSV's known anomaly.
 */
describe('maintenance jobs (e2e)', () => {
  let t: TestApp;
  const log = { log: vi.fn(), error: vi.fn() };

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await t.prisma
      .$executeRaw`TRUNCATE TABLE turbine_latest, farm_live_summary, anomaly_episodes, anomaly_expected_power, anomaly_rollup_state, telemetry_alerts, telemetry, held_telemetry, unallocated_turbines`;
    log.log.mockClear();
    log.error.mockClear();
  });

  const env = (extra: Record<string, string> = {}) => ({
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    ...extra,
  });

  const upload = (rows: string[]) => {
    const form = new FormData();
    form.append(
      'file',
      new Blob([[HEADER, ...rows].join('\n')], { type: 'text/csv' }),
      'readings.csv',
    );
    return fetch(`${t.url}/ingest/telemetry`, { method: 'POST', body: form });
  };

  const partitions = async () =>
    (
      await t.prisma.$queryRaw<{ name: string }[]>`
        SELECT c.relname AS name FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
        WHERE i.inhparent = 'telemetry'::regclass ORDER BY 1`
    ).map((r) => r.name);

  describe('partition-maintenance', () => {
    const run = (extra: Record<string, string> = {}) =>
      runJobCli(partitionMaintenanceJob, { argv: [], env: env(extra), log });
    const iso = (offsetDays: number) =>
      new Date(Date.now() + offsetDays * DAY).toISOString().slice(0, 10);

    it('creates today and the days ahead, and keeps every old reading when no retention is set', async () => {
      const old = iso(-100);
      expect(
        (await upload([`TURB001,FARM01,${old}T10:00:00Z,,1000,9,14,3,80`]))
          .status,
      ).toBe(201);

      expect(await run()).toBe(0);

      const names = await partitions();
      for (let d = 0; d <= 3; d++) {
        expect(names).toContain(`telemetry_p${iso(d).replaceAll('-', '')}`);
      }
      expect(await t.prisma.telemetry.count()).toBe(1); // the 100-day-old backfill survives
      expect(log.log).toHaveBeenCalledWith(
        expect.stringContaining('no retention set: nothing dropped'),
      );
      expect(await run()).toBe(0); // repeatable
    });

    it('with TELEMETRY_RETENTION_DAYS deletes the old backfill from the DEFAULT partition, keeps recent days', async () => {
      const old = iso(-100);
      const recent = iso(-1);
      await upload([
        `TURB001,FARM01,${old}T10:00:00Z,,1000,9,14,3,80`,
        `TURB001,FARM01,${recent}T10:00:00Z,,1000,9,14,3,80`,
      ]);
      expect(await t.prisma.telemetry.count()).toBe(2);

      expect(await run({ TELEMETRY_RETENTION_DAYS: '31' })).toBe(0);

      const left = await t.prisma.telemetry.findMany();
      expect(left.map((r) => r.timestamp.toISOString())).toEqual([
        `${recent}T10:00:00.000Z`,
      ]);
      // The recent day was carved out of DEFAULT into its own partition.
      expect(await partitions()).toContain(
        `telemetry_p${recent.replaceAll('-', '')}`,
      );
      expect(
        (
          await t.prisma.$queryRaw<
            { n: number }[]
          >`SELECT count(*)::int AS n FROM telemetry_default`
        )[0].n,
      ).toBe(0);
    });

    it('rejects an invalid retention with exit code 1', async () => {
      expect(await run({ TELEMETRY_RETENTION_DAYS: 'a month' })).toBe(1);
      expect(log.error).toHaveBeenCalledWith(
        expect.stringContaining('TELEMETRY_RETENTION_DAYS'),
      );
    });
  });

  describe('live-summary', () => {
    const run = (argv: string[] = []) =>
      runJobCli(liveSummaryJob, { argv, env: env(), log });

    it('rebuilds farm_live_summary from turbine_latest and publishes fleet.tick on the stream', async () => {
      const recent =
        new Date(Date.now() - 2 * 60_000).toISOString().slice(0, 19) + 'Z';
      await upload([`TURB001,FARM01,${recent},,1000,9,14,3,80`]);
      const marker = (await t.events.publish('test.marker', null)).id;

      expect(await run()).toBe(0);

      const farm = await t.prisma.farmLiveSummary.findUniqueOrThrow({
        where: { farmId: 'FARM01' },
      });
      expect(farm).toMatchObject({
        turbines: 1,
        reporting: 1,
        stale: 0,
        powerOutputKw: 1000,
        windSpeedMs: 9,
      });
      const events = await t.events.since(marker);
      expect(events).toEqual([
        expect.objectContaining({
          type: 'fleet.tick',
          data: { asOf: farm.asOf.toISOString() },
        }),
      ]);
    });

    it('--no-publish only rebuilds; a Redis failure is logged but the summaries are kept', async () => {
      const marker = (await t.events.publish('test.marker', null)).id;
      expect(await run(['--no-publish'])).toBe(0);
      expect(await t.events.since(marker)).toEqual([]);
      expect(await t.prisma.farmLiveSummary.count()).toBe(10);

      await t.prisma.farmLiveSummary.deleteMany();
      expect(
        await runJobCli(liveSummaryJob, {
          argv: [],
          env: {
            DATABASE_URL: process.env.DATABASE_URL,
            REDIS_URL: 'redis://127.0.0.1:1',
          },
          log,
        }),
      ).toBe(0);
      expect(await t.prisma.farmLiveSummary.count()).toBe(10);
      expect(log.log).toHaveBeenCalledWith(
        expect.stringContaining('tick NOT published'),
      );
    });
  });

  describe('anomaly-rollup', () => {
    it('stores a frozen turbine (0 kW in strong wind) as a low_power_in_wind episode, and a second run changes nothing', async () => {
      // The provided CSV's TURB001 fault, moved to a few hours ago (episodes older than 62 days
      // are pruned): normal output, 4 readings of 0 kW at 15.8 m/s, normal output again.
      const base = Math.floor((Date.now() - 3 * 3_600_000) / 300_000) * 300_000;
      const at = (i: number) =>
        new Date(base + i * 300_000).toISOString().slice(0, 19) + 'Z';
      const rows = [0, 1, 2, 3, 4, 5, 6].map((i) =>
        i >= 2 && i <= 5
          ? `TURB001,FARM01,${at(i)},,0,15.8,0,0,70`
          : `TURB001,FARM01,${at(i)},,${3000 + i},14.${i},12,3,70.${i}`,
      );
      expect((await upload(rows)).status).toBe(201);

      const run = () =>
        runJobCli(anomalyRollupJob, { argv: [], env: env(), log });
      expect(await run()).toBe(0);

      const episodes = await t.prisma.anomalyEpisode.findMany({
        where: { kind: 'low_power_in_wind' },
      });
      expect(episodes).toHaveLength(1);
      expect(episodes[0]).toMatchObject({
        turbineId: 'TURB001',
        farmId: 'FARM01',
        episodeStart: new Date(at(2)),
        episodeEnd: new Date(at(5)),
        readings: 4,
        windSpeedMs: 15.8,
      });

      const all = () =>
        t.prisma.anomalyEpisode.findMany({
          orderBy: [{ turbineId: 'asc' }, { episodeStart: 'asc' }],
        });
      const strip = (list: Awaited<ReturnType<typeof all>>) =>
        list.map(({ id: _id, computedAt: _c, ...rest }) => rest);
      const before = strip(await all());
      expect(await run()).toBe(0);
      expect(strip(await all())).toEqual(before);
    });

    it('--from is refused for a day in the future, and --every cannot be combined with it', async () => {
      const next = new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10);
      expect(
        await runJobCli(anomalyRollupJob, {
          argv: ['--from', next],
          env: env(),
          log,
        }),
      ).toBe(1);
      expect(
        await runJobCli(anomalyRollupJob, {
          argv: ['--from', '2026-01-01', '--every', '60'],
          env: env(),
          log,
        }),
      ).toBe(1);
    });
  });
});
