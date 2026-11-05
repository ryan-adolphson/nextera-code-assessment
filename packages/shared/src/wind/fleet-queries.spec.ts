import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import type { PrismaClient } from '../generated/prisma/client.js';
import {
  MAX_TURBINE_MARKERS,
  alertsPage,
  fleetSummary,
  listFarmSummaries,
  listTurbines,
  turbineItem,
  turbineMarkers,
} from './fleet-queries.js';
import { QueryInputError, QueryNotFoundError } from './query-support.js';

const cursor = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

const NOW = new Date('2026-01-02T00:20:00Z');

describe('fleet queries (mocked Prisma)', () => {
  let prisma: DeepMockProxy<PrismaClient>;

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
  });

  describe('listTurbines arguments', () => {
    it.each([
      [{ limit: 0 }, 'limit must be 1 to 100'],
      [{ limit: 101 }, 'limit must be 1 to 100'],
      [{ limit: 1.5 }, 'limit must be 1 to 100'],
      [{ sort: 'nope' as never }, /sort must be one of/],
      [{ dir: 'up' as never }, 'dir must be asc or desc'],
      [{ sort: 'power' as const }, /Sorting by power needs a farmId/],
      [{ sort: 'wind' as const, q: 'x' }, /Sorting by wind needs a farmId/],
      [{ sort: 'gearbox' as const }, /Sorting by gearbox needs a farmId/],
    ])('rejects %j with a QueryInputError, without querying', async (q, m) => {
      const run = listTurbines(prisma, q);
      await expect(run).rejects.toBeInstanceOf(QueryInputError);
      await expect(run).rejects.toThrow(m);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it.each([
      ['not base64 json', 'not-a-cursor'],
      ['an array', cursor([1])],
      ['no direction', cursor({ s: 'id', d: 'asc', k: null, i: 'T1' })],
      ['no id', cursor({ b: 'a', s: 'id', d: 'asc', k: null })],
      ['an id key', cursor({ b: 'a', s: 'id', d: 'asc', k: 'x', i: 'T1' })],
    ])('rejects a malformed cursor (%s)', async (_, c) => {
      await expect(listTurbines(prisma, { cursor: c })).rejects.toThrow(
        'Invalid cursor',
      );
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('rejects a cursor of another sort or direction', async () => {
      const c = cursor({ b: 'a', s: 'time', d: 'asc', k: null, i: 'T1' });
      await expect(listTurbines(prisma, { cursor: c })).rejects.toThrow(
        'The cursor belongs to a different sort',
      );
      await expect(
        listTurbines(prisma, { cursor: c, sort: 'time', dir: 'desc' }),
      ).rejects.toThrow('The cursor belongs to a different sort');
    });

    it.each([
      ['a farm key that is null', { s: 'farm', k: null }],
      ['a commissioned key that is a string', { s: 'commissioned', k: 'x' }],
      ['a time key that is no date', { s: 'time', k: 'yesterday' }],
    ])('rejects %s', async (_, c) => {
      const raw = cursor({ b: 'a', d: 'asc', i: 'T1', ...c });
      await expect(
        listTurbines(prisma, { cursor: raw, sort: c.s as never }),
      ).rejects.toThrow('Invalid cursor');
    });

    it('answers contradicting filters with an empty page and no query for the rows', async () => {
      const result = await listTurbines(prisma, {
        status: 'reporting',
        hasData: false,
      });

      expect(result).toEqual({
        items: [],
        nextCursor: null,
        prevCursor: null,
        total: 0,
        totalCapped: false,
      });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  it('turbineItem throws QueryNotFoundError for an unknown turbine', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    await expect(turbineItem(prisma, 'TURB999')).rejects.toThrow(
      new QueryNotFoundError('Turbine TURB999 not found'),
    );
  });

  describe('turbineMarkers', () => {
    it('throws QueryNotFoundError for an unknown farm', async () => {
      prisma.farm.findUnique.mockResolvedValue(null);
      await expect(turbineMarkers(prisma, 'FARM99')).rejects.toThrow(
        new QueryNotFoundError('Farm FARM99 not found'),
      );
    });

    it('derives the status from the latest reading and the clock', async () => {
      prisma.farm.findUnique.mockResolvedValue({ id: 'FARM01' } as never);
      prisma.$queryRaw.mockResolvedValue([
        {
          turbine_id: 'T1',
          latitude: '1.5',
          longitude: '2.5',
          ts: new Date('2026-01-02T00:10:00Z'),
        },
        {
          turbine_id: 'T2',
          latitude: '1',
          longitude: '2',
          ts: new Date('2026-01-02T00:04:59Z'),
        },
        { turbine_id: 'T3', latitude: '1', longitude: '2', ts: null },
      ]);

      const markers = await turbineMarkers(prisma, 'FARM01', { now: NOW });

      expect(markers.map((m) => [m.id, m.status, m.timestamp])).toEqual([
        ['T1', 'reporting', '2026-01-02T00:10:00.000Z'],
        ['T2', 'stale', '2026-01-02T00:04:59.000Z'], // 15 min 1 s old
        ['T3', 'no_data', null],
      ]);
      expect(markers[0]).toMatchObject({ latitude: 1.5, longitude: 2.5 });
    });

    it('limits the query to MAX_TURBINE_MARKERS', async () => {
      prisma.farm.findUnique.mockResolvedValue({ id: 'FARM01' } as never);
      prisma.$queryRaw.mockResolvedValue([]);

      await turbineMarkers(prisma, 'FARM01');

      const [, ...values] = prisma.$queryRaw.mock
        .calls[0] as unknown as unknown[];
      expect(values).toContain(MAX_TURBINE_MARKERS);
    });
  });

  describe('alertsPage', () => {
    const range = { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' };

    it.each([
      [{ limit: 0 }, 'limit must be 1 to 1000'],
      [{ limit: 1001 }, 'limit must be 1 to 1000'],
      [{ cursor: 'junk' }, 'Invalid cursor'],
      [{ cursor: cursor({ at: 'x', id: 'y' }) }, 'Invalid cursor'],
      [{ from: range.to, to: range.from }, 'to must be after from'],
      [
        { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:01Z' },
        'The range may span at most 31 days',
      ],
    ])('rejects %j without querying', async (extra, message) => {
      await expect(alertsPage(prisma, { ...range, ...extra })).rejects.toThrow(
        message,
      );
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('returns an empty page without a cursor when nothing is flagged', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      expect(await alertsPage(prisma, range)).toEqual({
        items: [],
        nextCursor: null,
      });
    });
  });

  describe('live summaries', () => {
    it('listFarmSummaries uses the stored summary and computes only the missing farms', async () => {
      const farm = (id: string, liveSummary: unknown) => ({
        id,
        name: id,
        latitude: { toNumber: () => 1 },
        longitude: { toNumber: () => 2 },
        liveSummary,
      });
      prisma.farm.findMany.mockResolvedValue([
        farm('FARM01', {
          turbines: 4,
          commissioned: 3,
          reporting: 2,
          stale: 1,
          alerting: 1,
          powerOutputKw: 500,
          windSpeedMs: 7.5,
          asOf: new Date('2026-01-02T00:19:00Z'),
        }),
        farm('FARM02', null),
      ] as never);
      prisma.$queryRaw.mockResolvedValue([
        {
          farm_id: 'FARM02',
          turbines: 2,
          commissioned: 0,
          reporting: 0,
          stale: 0,
          alerting: 0,
          power: 0,
          wind: null,
        },
      ]);

      const farms = await listFarmSummaries(prisma, { now: NOW });

      expect(farms).toEqual([
        expect.objectContaining({
          id: 'FARM01',
          turbineCount: 4,
          commissioned: 3,
          reporting: 2,
          stale: 1,
          alerting: 1,
          powerOutputKw: 500,
          windSpeedMs: 7.5,
          asOf: '2026-01-02T00:19:00.000Z',
        }),
        expect.objectContaining({
          id: 'FARM02',
          turbineCount: 2,
          windSpeedMs: null,
          asOf: NOW.toISOString(),
        }),
      ]);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('fleetSummary adds the farms without a summary to the stored totals', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            farms: 3,
            summarised: 2,
            turbines: 10,
            commissioned: 8,
            reporting: 6,
            stale: 2,
            alerting: 1,
            power: 1000,
            as_of: new Date('2026-01-02T00:19:00Z'),
          },
        ])
        .mockResolvedValueOnce([{ id: 'FARM03' }])
        .mockResolvedValueOnce([
          {
            farm_id: 'FARM03',
            turbines: 5,
            commissioned: 1,
            reporting: 5,
            stale: 0,
            alerting: 0,
            power: 250,
            wind: 6,
          },
        ]);

      expect(await fleetSummary(prisma, { now: NOW })).toEqual({
        farms: 3,
        turbines: 15,
        commissioned: 9,
        reporting: 11,
        stale: 2,
        alerting: 1,
        powerOutputKw: 1250,
        asOf: '2026-01-02T00:19:00.000Z', // the oldest
      });
    });
  });
});
