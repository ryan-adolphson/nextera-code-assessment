import { readFileSync } from 'node:fs';
import { Prisma, type WeatherWriteClient } from '@nextera/shared';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import {
  parseWeatherSyncArgs,
  runWeatherSync,
  type WeatherSyncDeps,
} from './weather-sync.js';

const NOW = new Date('2026-10-31T01:30:00Z');
const ARCHIVE = readFileSync(
  new URL(
    '../../../../packages/shared/src/weather/__fixtures__/archive-farm01-2026-01-01.json',
    import.meta.url,
  ),
  'utf8',
);

describe('parseWeatherSyncArgs', () => {
  it('defaults to the last 7 UTC days up to today, every farm', () => {
    expect(parseWeatherSyncArgs([], NOW)).toEqual({
      from: '2026-10-25',
      to: '2026-10-31',
      farmIds: [],
    });
  });

  it('reads --from, --to and repeated --farm (deduplicated)', () => {
    expect(
      parseWeatherSyncArgs(
        [
          '--from',
          '2026-01-01',
          '--to=2026-01-31',
          '--farm',
          'FARM01',
          '--farm',
          'FARM02',
          '--farm',
          'FARM01',
        ],
        NOW,
      ),
    ).toEqual({
      from: '2026-01-01',
      to: '2026-01-31',
      farmIds: ['FARM01', 'FARM02'],
    });
  });

  it('defaults --from to 7 days ending at --to', () => {
    expect(parseWeatherSyncArgs(['--to', '2026-01-07'], NOW)).toMatchObject({
      from: '2026-01-01',
      to: '2026-01-07',
    });
  });

  it.each([
    [['--from', '2026-02-30'], '--from must be a day written as YYYY-MM-DD'],
    [['--to', '2026-01-01T00:00Z'], '--to must be a day written as YYYY-MM-DD'],
    [
      ['--from', '2026-01-02', '--to', '2026-01-01'],
      '--to must not be before --from',
    ],
    [['--to', '2026-11-01'], '--to must not be after today (2026-10-31)'],
    [['--farm', ' '], '--farm must not be empty'],
    [['--days', '3'], "Unknown option '--days'"],
    [['FARM01'], 'Unexpected argument'],
  ])('rejects %j', (argv, message) => {
    expect(() => parseWeatherSyncArgs(argv, NOW)).toThrow(message);
  });
});

describe('runWeatherSync', () => {
  let db: DeepMockProxy<WeatherWriteClient & { $disconnect(): Promise<void> }>;
  const log = { log: vi.fn(), error: vi.fn() };
  const createDb = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    db = mockDeep();
    db.$disconnect.mockResolvedValue(undefined);
    db.$executeRaw.mockImplementation((async () => 24) as never);
    db.farm.findMany.mockResolvedValue([
      {
        id: 'FARM01',
        latitude: new Prisma.Decimal('41.25'),
        longitude: new Prisma.Decimal('-96.53'),
      },
    ] as never);
    createDb.mockReturnValue(db);
  });

  const run = (overrides: Partial<WeatherSyncDeps> = {}) =>
    runWeatherSync({
      argv: ['--from', '2026-01-01', '--to', '2026-01-01'],
      env: { DATABASE_URL: 'postgresql://db' },
      createDb,
      now: () => NOW,
      fetch: (async () => new Response(ARCHIVE)) as never,
      sleep: async () => undefined,
      log,
      ...overrides,
    });

  it('syncs, logs one line per farm, exits 0 and disconnects', async () => {
    expect(await run()).toBe(0);
    expect(createDb).toHaveBeenCalledWith('postgresql://db');
    expect(log.log.mock.calls.map(([line]) => line)).toEqual([
      'Weather sync: 2026-01-01..2026-01-01, every farm, Open-Meteo free API (non-commercial use only)',
      'Weather sync: FARM01: ok: 24 archive + 0 forecast hours, 24 rows written',
      'Weather sync: 1/1 farms synced, 24 rows written',
    ]);
    expect(db.$disconnect).toHaveBeenCalled();
  });

  it('uses the customer host with OPEN_METEO_API_KEY, without logging the key', async () => {
    const fetch = vi.fn(async () => new Response(ARCHIVE));
    await run({
      env: { DATABASE_URL: 'postgresql://db', OPEN_METEO_API_KEY: 's3cret' },
      fetch: fetch as never,
    });
    const [url] = fetch.mock.calls[0] as unknown as [URL];
    expect(url.host).toBe('customer-archive-api.open-meteo.com');
    expect(url.searchParams.get('apikey')).toBe('s3cret');
    expect(JSON.stringify(log.log.mock.calls)).not.toContain('s3cret');
  });

  it('exits 1 when a farm failed', async () => {
    const code = await run({
      fetch: (async () =>
        new Response('{"error":true,"reason":"nope"}', {
          status: 400,
        })) as never,
    });
    expect(code).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      'Weather sync: 0/1 farms synced, 0 rows written, 1 failed',
    );
    expect(db.$disconnect).toHaveBeenCalled();
  });

  it('exits 1 without DATABASE_URL or with bad arguments, before connecting', async () => {
    expect(await run({ env: {} })).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      'Weather sync: DATABASE_URL is not set',
    );
    expect(await run({ argv: ['--from', 'yesterday'] })).toBe(1);
    expect(log.error).toHaveBeenLastCalledWith(
      expect.stringContaining('--from must be a day written as YYYY-MM-DD'),
    );
    expect(createDb).not.toHaveBeenCalled();
  });

  it('exits 1 when the database fails', async () => {
    db.farm.findMany.mockRejectedValue(new Error('connection refused'));
    expect(await run()).toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      'Weather sync: failed: connection refused',
    );
    expect(db.$disconnect).toHaveBeenCalled();
  });
});
