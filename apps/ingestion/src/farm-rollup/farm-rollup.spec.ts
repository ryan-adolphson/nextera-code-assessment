import type { EventStore, FarmRollupResult } from '@nextera/shared';
import {
  describeRun,
  parseFarmRollupArgs,
  runFarmRollupCli,
  type FarmRollupCliDeps,
} from './farm-rollup.js';

const NOW = new Date('2026-11-01T10:00:00Z');
const ENV = { DATABASE_URL: 'postgresql://x@localhost/db' };

const result = (
  overrides: Partial<FarmRollupResult> = {},
): FarmRollupResult => ({
  skipped: false,
  firstRun: false,
  farms: 10,
  from: '2026-11-01T00:00:00.000Z',
  written: 200,
  deleted: 190,
  pruned: 0,
  dirty: 0,
  cutoff: '2026-04-25T10:00:00.000Z',
  watermark: '2026-11-01T10:00:00.000Z',
  ...overrides,
});

describe('parseFarmRollupArgs', () => {
  it('defaults to one incremental run', () => {
    expect(parseFarmRollupArgs([], NOW)).toEqual({
      mode: { kind: 'incremental' },
      every: undefined,
    });
  });

  it('reads --full, --from and --every', () => {
    expect(parseFarmRollupArgs(['--full'], NOW)).toMatchObject({
      mode: { kind: 'full' },
    });
    expect(parseFarmRollupArgs(['--from', '2026-10-01'], NOW)).toEqual({
      mode: { kind: 'from', day: '2026-10-01' },
    });
    expect(parseFarmRollupArgs(['--every', '900'], NOW)).toEqual({
      mode: { kind: 'incremental' },
      every: 900,
    });
  });

  it.each([
    [['--from', '2026-02-30'], '--from must be a day written as YYYY-MM-DD'],
    [['--from', '2026-11-02'], '--from must not be after today (2026-11-01)'],
    [
      ['--full', '--from', '2026-10-01'],
      '--full and --from are mutually exclusive',
    ],
    [['--every', '900', '--full'], '--every runs incrementally'],
    [['--every', '0'], '--every must be a whole number of seconds'],
    [['--every', '1.5'], '--every must be a whole number of seconds'],
    [['--every', 'often'], '--every must be a whole number of seconds'],
    [['--since', 'x'], "Unknown option '--since'"],
    [['now'], 'Unexpected argument'],
  ])('rejects %j', (argv, message) => {
    expect(() => parseFarmRollupArgs(argv, NOW)).toThrow(message);
  });
});

describe('runFarmRollupCli', () => {
  const setup = (overrides: Partial<FarmRollupCliDeps> = {}) => {
    const db = {
      $transaction: vi.fn(),
      $disconnect: vi.fn().mockResolvedValue(undefined),
    };
    const log = { log: vi.fn(), error: vi.fn() };
    const run = vi.fn().mockResolvedValue(result());
    const deps: FarmRollupCliDeps = {
      argv: [],
      env: ENV,
      createDb: vi.fn(() => db),
      run,
      now: () => NOW,
      log,
      ...overrides,
    };
    return { db, log, run, deps };
  };

  it('runs once with a small pool, logs a summary and exits 0', async () => {
    const { db, log, run, deps } = setup({ argv: ['--full'] });

    expect(await runFarmRollupCli(deps)).toBe(0);

    expect(deps.createDb).toHaveBeenCalledWith(ENV.DATABASE_URL);
    expect(run).toHaveBeenCalledWith(db, { mode: { kind: 'full' }, now: NOW });
    expect(log.log).toHaveBeenCalledWith(
      expect.stringMatching(
        /^Farm rollup: 10 farms from 2026-11-01T00:00:00.000Z, 200 rows written/,
      ),
    );
    expect(db.$disconnect).toHaveBeenCalled();
  });

  describe('completion event', () => {
    const withEvents = (overrides: Partial<FarmRollupCliDeps> = {}) => {
      const events = {
        publish: vi.fn().mockResolvedValue({}),
        onModuleDestroy: vi.fn().mockResolvedValue(undefined),
      };
      const createEvents = vi.fn(() => events as unknown as EventStore);
      const s = setup({
        env: { ...ENV, REDIS_URL: 'redis://localhost' },
        createEvents,
        ...overrides,
      });
      return { ...s, events, createEvents };
    };

    it('publishes asOf = the watermark after a successful run, then closes', async () => {
      const { events, createEvents, log, deps } = withEvents();
      expect(await runFarmRollupCli(deps)).toBe(0);
      expect(createEvents).toHaveBeenCalledWith(deps.env);
      expect(events.publish).toHaveBeenCalledWith('farm-rollup.completed', {
        asOf: '2026-11-01T10:00:00.000Z',
      });
      expect(log.log).toHaveBeenCalledWith(
        expect.stringMatching(/event published$/),
      );
      expect(events.onModuleDestroy).toHaveBeenCalled();
    });

    it('does not publish when the run is skipped or fails', async () => {
      const skipped = withEvents({
        run: vi
          .fn()
          .mockResolvedValue(result({ skipped: true, watermark: null })),
      });
      expect(await runFarmRollupCli(skipped.deps)).toBe(0);
      expect(skipped.events.publish).not.toHaveBeenCalled();

      const failed = withEvents({
        run: vi.fn().mockRejectedValue(new Error('boom')),
      });
      expect(await runFarmRollupCli(failed.deps)).toBe(1);
      expect(failed.events.publish).not.toHaveBeenCalled();
      expect(failed.events.onModuleDestroy).toHaveBeenCalled();
    });

    it('still exits 0 when Redis fails', async () => {
      const { events, log, deps } = withEvents();
      events.publish.mockRejectedValue(new Error('redis down'));
      expect(await runFarmRollupCli(deps)).toBe(0);
      expect(log.log).toHaveBeenCalledWith(
        expect.stringContaining('event NOT published: redis down'),
      );
      expect(log.error).not.toHaveBeenCalled();
    });

    it('without REDIS_URL creates no EventStore and publishes nothing', async () => {
      const createEvents = vi.fn();
      const { log, run, deps } = setup({ createEvents });
      expect(await runFarmRollupCli(deps)).toBe(0);
      expect(run).toHaveBeenCalled();
      expect(createEvents).not.toHaveBeenCalled();
      expect(log.log).toHaveBeenCalledWith(
        expect.stringContaining('REDIS_URL is not set'),
      );
    });
  });

  it('exits 0 when another run holds the lock', async () => {
    const { log, deps } = setup({
      run: vi.fn().mockResolvedValue(result({ skipped: true })),
    });
    expect(await runFarmRollupCli(deps)).toBe(0);
    expect(log.log).toHaveBeenCalledWith(
      'Farm rollup: skipped, another run holds the lock',
    );
  });

  it('exits 1 when a single run fails, and still disconnects', async () => {
    const { db, log, deps } = setup({
      run: vi.fn().mockRejectedValue(new Error('connection refused')),
    });
    expect(await runFarmRollupCli(deps)).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      'Farm rollup: failed: connection refused',
    );
    expect(db.$disconnect).toHaveBeenCalled();
  });

  it('exits 1 without DATABASE_URL or with bad arguments, before connecting', async () => {
    const noUrl = setup({ env: {} });
    expect(await runFarmRollupCli(noUrl.deps)).toBe(1);
    expect(noUrl.log.error).toHaveBeenCalledWith(
      'Farm rollup: DATABASE_URL is not set',
    );
    const badArgs = setup({ argv: ['--every', 'x'] });
    expect(await runFarmRollupCli(badArgs.deps)).toBe(1);
    expect(badArgs.log.error).toHaveBeenCalledWith(
      expect.stringContaining('Usage: farm-rollup'),
    );
    expect(noUrl.deps.createDb).not.toHaveBeenCalled();
    expect(badArgs.deps.createDb).not.toHaveBeenCalled();
  });

  it('--every: keeps looping after a failed run, sleeps the interval, and exits 0 when stopped', async () => {
    const controller = new AbortController();
    const run = vi
      .fn()
      .mockResolvedValueOnce(result())
      .mockRejectedValueOnce(new Error('the database system is shutting down'))
      .mockResolvedValueOnce(result({ written: 7 }));
    const sleep = vi.fn(async () => {
      if (run.mock.calls.length === 3) controller.abort(); // SIGTERM during the 3rd wait
    });
    const { db, log, deps } = setup({
      argv: ['--every', '900'],
      run,
      sleep,
      signal: controller.signal,
    });

    expect(await runFarmRollupCli(deps)).toBe(0);

    expect(run).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledWith(900_000, controller.signal);
    expect(log.error).toHaveBeenCalledWith(
      'Farm rollup: failed: the database system is shutting down',
    );
    expect(log.log).toHaveBeenCalledWith(
      expect.stringContaining('7 rows written'),
    );
    expect(log.log).toHaveBeenLastCalledWith('Farm rollup: stopped');
    expect(db.$disconnect).toHaveBeenCalledTimes(1);
  });

  it('describes a first run', () => {
    expect(describeRun(result({ firstRun: true }), 12)).toMatch(
      /^Farm rollup: first run \(full\), 10 farms .* in 12 ms$/,
    );
  });
});
