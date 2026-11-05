import { parseEvery, runJobCli, type JobDefinition } from './job-runner.js';

interface Args {
  every?: number;
}

const log = { log: vi.fn(), error: vi.fn() };
const db = { $disconnect: vi.fn().mockResolvedValue(undefined) };

const job = (
  overrides: Partial<JobDefinition<Args, undefined>> = {},
): JobDefinition<Args, undefined> => ({
  name: 'Test job',
  usage: 'Usage: test',
  parseArgs: (argv) => ({
    every: argv[0] ? Number(argv[0]) : undefined,
  }),
  run: vi.fn().mockResolvedValue('did it'),
  ...overrides,
});

const deps = (extra: object = {}) => ({
  argv: [] as string[],
  env: { DATABASE_URL: 'postgresql://x' },
  createDb: () => db as never,
  now: () => new Date('2026-03-01T00:00:00Z'),
  log,
  ...extra,
});

describe('runJobCli', () => {
  beforeEach(() => {
    log.log.mockClear();
    log.error.mockClear();
    db.$disconnect.mockClear();
  });

  it('runs once, logs the line and disconnects (exit 0)', async () => {
    const j = job();
    await expect(runJobCli(j, deps())).resolves.toBe(0);
    expect(j.run).toHaveBeenCalledWith(
      db,
      {},
      undefined,
      new Date('2026-03-01T00:00:00Z'),
    );
    expect(log.log).toHaveBeenCalledWith(
      expect.stringMatching(/^Test job: did it \(\d+ ms\)$/),
    );
    expect(db.$disconnect).toHaveBeenCalledOnce();
  });

  it('exits 1 on bad arguments (with the usage), a missing DATABASE_URL or a failed run', async () => {
    await expect(
      runJobCli(
        job({
          parseArgs: () => {
            throw new Error('bad flag');
          },
        }),
        deps(),
      ),
    ).resolves.toBe(1);
    expect(log.error).toHaveBeenCalledWith('Test job: bad flag\nUsage: test');

    await expect(runJobCli(job(), deps({ env: {} }))).resolves.toBe(1);
    expect(log.error).toHaveBeenCalledWith('Test job: DATABASE_URL is not set');

    await expect(
      runJobCli(
        job({ run: vi.fn().mockRejectedValue(new Error('db down')) }),
        deps(),
      ),
    ).resolves.toBe(1);
    expect(log.error).toHaveBeenCalledWith('Test job: failed: db down');
    expect(db.$disconnect).toHaveBeenCalledOnce();
  });

  it('loops with --every, survives a failed run and exits 0 when the signal aborts', async () => {
    const controller = new AbortController();
    const run = vi
      .fn()
      .mockRejectedValueOnce(new Error('blip'))
      .mockResolvedValue('ok');
    let sleeps = 0;
    const sleep = vi.fn(() => {
      if (++sleeps === 2) controller.abort();
      return Promise.resolve();
    });

    await expect(
      runJobCli(
        job({ run }),
        deps({ argv: ['60'], sleep, signal: controller.signal }),
      ),
    ).resolves.toBe(0);

    expect(run).toHaveBeenCalledTimes(2); // the failure did not stop the loop
    expect(sleep).toHaveBeenCalledWith(60_000, controller.signal);
    expect(log.log).toHaveBeenCalledWith('Test job: stopped');
  });

  it('opens and closes the resources around the runs', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const j = job({ open: () => undefined, close });
    await runJobCli(j, deps());
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('parseEvery', () => {
  it('accepts whole seconds from 1 to 86400', () => {
    expect(parseEvery(undefined)).toBeUndefined();
    expect(parseEvery('60')).toBe(60);
    expect(parseEvery('86400')).toBe(86_400);
  });

  it.each(['0', '-1', '1.5', 'abc', '86401', ''])('rejects %j', (value) => {
    expect(() => parseEvery(value)).toThrow(/--every/);
  });
});
