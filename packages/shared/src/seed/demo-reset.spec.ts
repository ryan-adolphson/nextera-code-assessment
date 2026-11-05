import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import type { PrismaClient } from '../generated/prisma/client.js';
import {
  DEMO_RESET_HOURS,
  assertResetTarget,
  clearDemoReadings,
  confirmDemoReset,
  countByPill,
  databaseTarget,
  demoStaleTurbines,
  describeTarget,
  expectedStalenessPill,
  parseDemoResetArgs,
} from './demo-reset.js';
import { DEMO_ANOMALIES } from './generate-telemetry.js';

const SECRET = 's3cr3t-pa55';

describe('demo reset', () => {
  it('covers 7 days, with every anomaly inside the window', () => {
    expect(DEMO_RESET_HOURS).toBe(168);
    const offsets = [
      DEMO_ANOMALIES.frozenPower.offsetMinutes,
      DEMO_ANOMALIES.pitchSpike.offsetMinutes,
      DEMO_ANOMALIES.gearboxStuck.offsetMinutes,
      DEMO_ANOMALIES.gap.offsetMinutes,
      ...DEMO_ANOMALIES.stopped.map((s) => s.offsetMinutes),
      ...DEMO_ANOMALIES.late.map((l) => l.offsetMinutes),
      ...DEMO_ANOMALIES.lagging.map((l) => l.lagMinutes),
    ];
    expect(Math.max(...offsets)).toBeLessThan(DEMO_RESET_HOURS * 60);
  });

  describe('parseDemoResetArgs', () => {
    it('defaults to asking, local only, with weather, feed and build', () => {
      expect(parseDemoResetArgs([])).toEqual({
        yes: false,
        allowRemote: false,
        weather: true,
        feed: true,
        build: true,
      });
    });

    it('reads every flag', () => {
      expect(
        parseDemoResetArgs([
          '--yes',
          '--allow-remote',
          '--no-weather',
          '--no-feed',
          '--no-build',
        ]),
      ).toEqual({
        yes: true,
        allowRemote: true,
        weather: false,
        feed: false,
        build: false,
      });
      expect(parseDemoResetArgs(['-y']).yes).toBe(true);
    });

    it.each([['--force'], ['now'], ['--yes=1']])('rejects %s', (arg) => {
      expect(() => parseDemoResetArgs([arg])).toThrow();
    });
  });

  describe('databaseTarget', () => {
    it.each([
      [
        `postgresql://nextera:${SECRET}@localhost:5433/nextera?schema=public`,
        'localhost',
        '5433',
        'nextera',
      ],
      [`postgres://u:${SECRET}@127.0.0.1/demo`, '127.0.0.1', '5432', 'demo'],
      [`postgresql://u:${SECRET}@[::1]:5433/nextera`, '::1', '5433', 'nextera'],
      [
        `postgresql://u:${SECRET}@postgres:5432/nextera`,
        'postgres',
        '5432',
        'nextera',
      ],
      [
        `postgresql://u:${SECRET}@NEXTERA-POSTGRES:5432/nextera`,
        'NEXTERA-POSTGRES',
        '5432',
        'nextera',
      ],
    ])('treats %s as local', (url, host, port, database) => {
      expect(databaseTarget(url)).toEqual({
        host,
        port,
        database,
        local: true,
      });
    });

    it.each([
      `postgresql://u:${SECRET}@10.0.0.5:5432/nextera`,
      `postgresql://u:${SECRET}@db.example.com/nextera`,
      `postgresql://u:${SECRET}@localhost.example.com/nextera`,
      `postgresql://u:${SECRET}@my-postgres/nextera`,
      // A socket (Cloud SQL Auth Proxy) wins over the URL's host, like in libpq.
      `postgresql://u:${SECRET}@localhost/nextera?host=/cloudsql/p:r:i`,
    ])('treats %s as remote', (url) => {
      expect(databaseTarget(url).local).toBe(false);
    });

    it('takes the socket directory as the host', () => {
      expect(
        databaseTarget(
          `postgresql://u:${SECRET}@localhost/nextera?host=/cloudsql/p:r:i`,
        ),
      ).toMatchObject({ host: '/cloudsql/p:r:i', database: 'nextera' });
    });

    it.each([undefined, '', 'not a url', `mysql://u:${SECRET}@localhost/db`])(
      'rejects %o without echoing it',
      (url) => {
        let message = '';
        try {
          databaseTarget(url);
        } catch (error) {
          message = (error as Error).message;
        }
        expect(message).toMatch(/DATABASE_URL/);
        expect(message).not.toContain(SECRET);
      },
    );

    it('describes the target without the user or password', () => {
      const target = databaseTarget(
        `postgresql://nextera:${SECRET}@localhost:5433/nextera?schema=public`,
      );
      expect(describeTarget(target)).toBe('localhost:5433/nextera');
    });
  });

  describe('assertResetTarget', () => {
    const local = databaseTarget('postgresql://u:p@localhost:5433/nextera');
    const remote = databaseTarget('postgresql://u:p@10.1.2.3:5432/prod');

    it('allows a local target', () => {
      expect(() =>
        assertResetTarget(local, { allowRemote: false }),
      ).not.toThrow();
    });

    it('refuses a remote target, naming host and database', () => {
      expect(() => assertResetTarget(remote, { allowRemote: false })).toThrow(
        /Refusing to reset 10\.1\.2\.3:5432\/prod.*--allow-remote/,
      );
    });

    it('allows a remote target with --allow-remote', () => {
      expect(() =>
        assertResetTarget(remote, { allowRemote: true }),
      ).not.toThrow();
    });
  });

  describe('confirmDemoReset', () => {
    const target = databaseTarget('postgresql://u:p@localhost:5433/nextera');
    const ask = vi.fn<(q: string) => Promise<string>>();
    beforeEach(() => ask.mockReset());

    it('goes on with --yes without asking, even without a terminal', async () => {
      await expect(
        confirmDemoReset({ yes: true, interactive: false, ask, target }),
      ).resolves.toBe(true);
      expect(ask).not.toHaveBeenCalled();
    });

    it('refuses without --yes when stdin is not a terminal', async () => {
      await expect(
        confirmDemoReset({ yes: false, interactive: false, ask, target }),
      ).rejects.toThrow(/without --yes/);
      expect(ask).not.toHaveBeenCalled();
    });

    it.each(['y', 'Y', 'yes', ' YES '])(
      'goes on when the answer is %o',
      async (answer) => {
        ask.mockResolvedValue(answer);
        await expect(
          confirmDemoReset({ yes: false, interactive: true, ask, target }),
        ).resolves.toBe(true);
        expect(ask).toHaveBeenCalledWith(
          expect.stringContaining('localhost:5433/nextera'),
        );
      },
    );

    it.each(['', 'n', 'no', 'yep', 'sure'])(
      'stops when the answer is %o',
      async (answer) => {
        ask.mockResolvedValue(answer);
        await expect(
          confirmDemoReset({ yes: false, interactive: true, ask, target }),
        ).resolves.toBe(false);
      },
    );
  });

  describe('clearDemoReadings', () => {
    let prisma: DeepMockProxy<PrismaClient>;
    const order: string[] = [];

    beforeEach(() => {
      prisma = mockDeep<PrismaClient>();
      order.length = 0;
      prisma.$transaction.mockImplementation((fn: unknown) =>
        (fn as (tx: PrismaClient) => Promise<unknown>)(prisma),
      );
      const count = (name: string, n: number) =>
        (() => {
          order.push(name);
          return Promise.resolve({ count: n });
        }) as never;
      prisma.telemetryAlert.deleteMany.mockImplementation(
        count('telemetry_alerts', 7),
      );
      prisma.telemetry.deleteMany.mockImplementation(count('telemetry', 100));
      prisma.heldTelemetry.deleteMany.mockImplementation(
        count('held_telemetry', 20),
      );
      prisma.unallocatedTurbine.deleteMany.mockImplementation(
        count('unallocated_turbines', 6),
      );
      prisma.farmWeather.deleteMany.mockImplementation(
        count('farm_weather', 50),
      );
      prisma.farmTelemetryRollup.deleteMany.mockImplementation(
        count('farm_telemetry_rollups', 30),
      );
      prisma.farmRollupDirty.deleteMany.mockImplementation(
        count('farm_rollup_dirty', 2),
      );
      prisma.farmRollupState.deleteMany.mockImplementation(
        count('farm_rollup_state', 1),
      );
      prisma.turbineLatest.deleteMany.mockImplementation(
        count('turbine_latest', 9),
      );
      prisma.farmLiveSummary.deleteMany.mockImplementation(
        count('farm_live_summary', 10),
      );
      prisma.anomalyEpisode.deleteMany.mockImplementation(
        count('anomaly_episodes', 3),
      );
      prisma.anomalyExpectedPower.deleteMany.mockImplementation(
        count('anomaly_expected_power', 25),
      );
      prisma.anomalyRollupState.deleteMany.mockImplementation(
        count('anomaly_rollup_state', 1),
      );
    });

    it('deletes the readings and what is derived from them in one transaction and keeps the setup', async () => {
      await expect(clearDemoReadings(prisma)).resolves.toEqual({
        telemetryAlerts: 7,
        telemetry: 100,
        heldTelemetry: 20,
        unallocatedTurbines: 6,
        farmWeather: 50,
        farmRollups: 30,
        turbineLatest: 9,
        farmLiveSummary: 10,
        anomalyEpisodes: 3,
      });
      expect(prisma.$transaction).toHaveBeenCalledOnce();
      expect(order).toEqual([
        'telemetry_alerts',
        'telemetry',
        'held_telemetry',
        'unallocated_turbines',
        'farm_weather',
        'farm_telemetry_rollups',
        'farm_rollup_dirty',
        'farm_rollup_state',
        'turbine_latest',
        'farm_live_summary',
        'anomaly_episodes',
        'anomaly_expected_power',
        'anomaly_rollup_state',
      ]);
      for (const kept of [
        prisma.farm.deleteMany,
        prisma.turbine.deleteMany,
        prisma.user.deleteMany,
        prisma.alertConfig.deleteMany,
      ]) {
        expect(kept).not.toHaveBeenCalled();
      }
    });
  });

  describe('staleness', () => {
    it.each([
      [5, 'Reporting'],
      [15, 'Reporting'],
      [20, 'No data in 15 min (yellow)'],
      [30, 'No data in 15 min (yellow)'],
      [45, 'No data in 30 min (orange)'],
      [60, 'No data in 30 min (orange)'],
      [90, 'No data in 60 min (red)'],
    ])('%i min old → %s', (minutes, pill) => {
      expect(expectedStalenessPill(minutes)).toBe(pill);
    });

    it('lists the 14 lagging turbines, then the 6 stopped ones: 8 yellow, 6 orange, 6 red', () => {
      const stale = demoStaleTurbines();
      expect(stale).toHaveLength(20);
      expect(stale.slice(0, 14).every((s) => s.kind === 'lagging')).toBe(true);
      expect(stale.slice(14).every((s) => s.kind === 'stopped')).toBe(true);
      expect(stale).toContainEqual({
        turbineId: 'TURB011',
        farmId: 'FARM04',
        minutesBehind: 20,
        kind: 'lagging',
      });
      expect(stale).toContainEqual({
        turbineId: 'TURB018',
        farmId: 'FARM07',
        minutesBehind: 45,
        kind: 'lagging',
      });
      expect(stale[14]).toEqual({
        turbineId: 'TURB013',
        farmId: 'FARM05',
        minutesBehind: 90,
        kind: 'stopped',
      });
      expect(stale.map((s) => s.farmId)).not.toContain('?');
      expect(
        countByPill(stale.map((s) => expectedStalenessPill(s.minutesBehind))),
      ).toEqual([
        ['No data in 15 min (yellow)', 8],
        ['No data in 30 min (orange)', 6],
        ['No data in 60 min (red)', 6],
      ]);
    });
  });
});
