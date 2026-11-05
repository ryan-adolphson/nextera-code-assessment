import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import type { PrismaClient } from '../generated/prisma/client.js';
import {
  PURGE_CHUNK,
  ensureTelemetryPartition,
  runPartitionMaintenance,
} from './partitions.js';

const NOW = new Date('2026-03-10T12:00:00Z');

describe('runPartitionMaintenance', () => {
  let db: DeepMockProxy<PrismaClient>;
  let lockHeldElsewhere = false;
  const sql = (call: unknown[]) => (call[0] as TemplateStringsArray).join('?');
  const ensured = () =>
    db.$queryRaw.mock.calls
      .filter((c) => sql(c).includes('telemetry_ensure_partition'))
      .map((c) => c[1]);

  beforeEach(() => {
    db = mockDeep<PrismaClient>();
    db.$queryRaw.mockImplementation(((strings: TemplateStringsArray) => {
      const text = strings.join('?');
      if (text.includes('telemetry_default')) return Promise.resolve([]);
      if (text.includes('telemetry_drop_partitions_before')) {
        return Promise.resolve([{ dropped: 2 }]);
      }
      return Promise.resolve([{ created: true }]);
    }) as never);
    db.$executeRaw.mockResolvedValue(0);
    // The run lock: an interactive transaction whose client answers the lock query.
    lockHeldElsewhere = false;
    db.$transaction.mockImplementation((async (fn: (tx: unknown) => unknown) =>
      fn({
        $queryRaw: () => Promise.resolve([{ locked: !lockHeldElsewhere }]),
      })) as never);
  });

  it('skips cleanly, touching nothing, when another run holds the lock', async () => {
    lockHeldElsewhere = true;
    const result = await runPartitionMaintenance(db, {
      now: NOW,
      retentionDays: 10,
    });
    expect(result).toEqual({
      created: [],
      dropped: 0,
      purgedDefault: 0,
      retentionCutoff: null,
      skipped: true,
    });
    expect(db.$queryRaw).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it('creates today and three days ahead, and deletes nothing without a retention', async () => {
    const result = await runPartitionMaintenance(db, { now: NOW });

    expect(ensured()).toEqual([
      '2026-03-10',
      '2026-03-11',
      '2026-03-12',
      '2026-03-13',
    ]);
    expect(result).toMatchObject({
      created: ['2026-03-10', '2026-03-11', '2026-03-12', '2026-03-13'],
      dropped: 0,
      purgedDefault: 0,
      retentionCutoff: null,
      skipped: false,
    });
    // No drop, no purge: local fixtures in the DEFAULT partition survive.
    expect(
      db.$queryRaw.mock.calls.some((c) =>
        sql(c).includes('telemetry_drop_partitions_before'),
      ),
    ).toBe(false);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it('also creates the days that have rows in the DEFAULT partition (backfills)', async () => {
    db.$queryRaw.mockImplementation(((strings: TemplateStringsArray) => {
      const text = strings.join('?');
      if (text.includes('FROM telemetry_default')) {
        return Promise.resolve([{ day: '2026-03-05' }, { day: '2026-03-07' }]);
      }
      return Promise.resolve([{ created: true }]);
    }) as never);

    await runPartitionMaintenance(db, { now: NOW, daysAhead: 0 });

    expect(ensured()).toEqual(['2026-03-05', '2026-03-07', '2026-03-10']);
  });

  it('with a retention: drops the days before the cutoff, then purges DEFAULT in chunks', async () => {
    db.$executeRaw.mockResolvedValueOnce(PURGE_CHUNK).mockResolvedValueOnce(7);

    const result = await runPartitionMaintenance(db, {
      now: NOW,
      retentionDays: 31,
    });

    expect(result).toMatchObject({
      dropped: 2,
      purgedDefault: PURGE_CHUNK + 7,
      retentionCutoff: '2026-02-07T12:00:00.000Z',
    });
    const drop = db.$queryRaw.mock.calls.find((c) =>
      sql(c).includes('telemetry_drop_partitions_before'),
    )!;
    expect(drop[1]).toBe('2026-02-07'); // whole days: the cutoff day itself is kept
    expect(db.$executeRaw).toHaveBeenCalledTimes(2);
  });

  it('rejects a retention below one day', async () => {
    await expect(
      runPartitionMaintenance(db, { now: NOW, retentionDays: 0 }),
    ).rejects.toThrow(/retentionDays/);
  });

  it('retries a lock timeout, then gives up', async () => {
    const timeout = Object.assign(
      new Error('canceling statement due to lock timeout'),
      {
        code: 'P2010',
        meta: { code: '55P03' },
      },
    );
    db.$queryRaw
      .mockRejectedValueOnce(timeout as never)
      .mockResolvedValueOnce([{ created: true }] as never);
    await expect(ensureTelemetryPartition(db, '2026-03-10')).resolves.toBe(
      true,
    );

    db.$queryRaw.mockReset();
    db.$queryRaw.mockRejectedValue(timeout as never);
    await expect(ensureTelemetryPartition(db, '2026-03-10')).rejects.toThrow(
      /lock timeout/,
    );
    expect(db.$queryRaw).toHaveBeenCalledTimes(3);
  });
});
