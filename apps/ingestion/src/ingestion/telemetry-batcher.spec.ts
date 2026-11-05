import { BadRequestException, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EventStore,
  MAX_PENDING_UNALLOCATED,
  PrismaService,
  TELEMETRY_RECEIVED,
  type Telemetry,
  type TelemetryRowInput,
} from '@nextera/shared';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { QueueFullException, QueueFullFilter } from './queue-full.exception.js';
import { TelemetryBatcher } from './telemetry-batcher.js';

const row = (turbineId: string, minute = 0, farmId = 'FARM01') =>
  ({
    turbineId,
    farmId,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, minute)),
    receivedAt: new Date('2026-01-01T01:00:00Z'),
    powerOutputKw: 1,
    windSpeedMs: 1,
    rotorRpm: 1,
    bladePitchDeg: 1,
    gearboxTempC: 1,
  }) satisfies TelemetryRowInput;

const stored = (r: TelemetryRowInput): Telemetry => ({
  ...r,
  id: `id-${r.turbineId}-${r.timestamp.getTime()}`,
  createdAt: new Date(),
});

describe('TelemetryBatcher', () => {
  let prisma: DeepMockProxy<PrismaService>;
  const events = { publish: vi.fn(), publishMany: vi.fn() };
  /** Transactions that wait for `release()`, in call order, to hold a flush open. */
  let gates: (() => void)[];
  let hold: boolean;

  const make = (batchMax = 100, maxQueued = 500) =>
    new TelemetryBatcher(
      prisma,
      events as unknown as EventStore,
      {
        get: (key: string) =>
          key === 'INGEST_BATCH_MAX' ? batchMax : maxQueued,
      } as unknown as ConfigService,
    );

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    prisma.turbine.findMany.mockResolvedValue([
      { turbineId: 'TURB001', farmId: 'FARM01' },
      { turbineId: 'TURB002', farmId: 'FARM01' },
      { turbineId: 'TURB003', farmId: 'FARM01' },
    ] as never);
    prisma.alertConfig.findMany.mockResolvedValue([]);
    prisma.unallocatedTurbine.findMany.mockResolvedValue([]);
    prisma.$queryRaw.mockResolvedValue([] as never);
    prisma.unallocatedTurbine.count.mockResolvedValue(0);
    prisma.unallocatedTurbine.create.mockResolvedValue({
      id: 'entry-1',
    } as never);
    prisma.heldTelemetry.createMany.mockImplementation(((a: {
      data: unknown[];
    }) => Promise.resolve({ count: a.data.length })) as never);
    prisma.telemetry.createManyAndReturn.mockImplementation(((a: {
      data: TelemetryRowInput[];
    }) => Promise.resolve(a.data.map(stored))) as never);
    gates = [];
    hold = false;
    prisma.$transaction.mockImplementation((async (
      fn: (tx: unknown) => unknown,
    ) => {
      if (hold) await new Promise<void>((resolve) => gates.push(resolve));
      return fn(prisma);
    }) as never);
    events.publish.mockReset();
    events.publishMany.mockReset();
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  const inserted = () =>
    prisma.telemetry.createManyAndReturn.mock.calls.map(
      ([a]) => (a as { data: unknown[] }).data.length,
    );

  it('flushes a lone reading at once, then groups what queued during the flush (up to the batch max)', async () => {
    const batcher = make(2);
    hold = true;
    const first = batcher.submit(row('TURB001', 0));
    const rest = [1, 2, 3].map((m) => batcher.submit(row('TURB002', m)));
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    expect(prisma.$transaction).toHaveBeenCalledTimes(1); // one flush at a time

    hold = false;
    gates[0]();
    await expect(Promise.all([first, ...rest])).resolves.toEqual([
      'stored',
      'stored',
      'stored',
      'stored',
    ]);
    expect(inserted()).toEqual([1, 2, 1]);
  });

  it('maps results back per reading: in-batch repeats and existing rows are duplicates, first wins', async () => {
    const batcher = make();
    hold = true;
    const first = batcher.submit(row('TURB001', 0));
    const a = batcher.submit(row('TURB002', 5));
    const repeat = batcher.submit(row('TURB002', 5));
    const existing = batcher.submit(row('TURB003', 5));
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    prisma.telemetry.createManyAndReturn.mockImplementation(((args: {
      data: TelemetryRowInput[];
    }) =>
      Promise.resolve(
        args.data.filter((r) => r.turbineId !== 'TURB003').map(stored),
      )) as never);
    hold = false;
    gates[0]();

    expect(await Promise.all([first, a, repeat, existing])).toEqual([
      'stored',
      'stored',
      'duplicate',
      'duplicate',
    ]);
    expect(inserted().at(-1)).toBe(2); // the repeat was never sent
  });

  it('handles a mix of stored, held and blocked readings in one transaction', async () => {
    const batcher = make();
    prisma.unallocatedTurbine.findMany.mockResolvedValue([
      { turbineId: 'TURB777', reportedFarmId: 'FARM01' },
    ] as never);
    hold = true;
    const first = batcher.submit(row('TURB001', 0));
    const known = batcher.submit(row('TURB002', 5));
    const unknown = batcher.submit(row('TURB999', 5));
    const blocked = batcher.submit(row('TURB777', 5));
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    hold = false;
    gates[0]();

    expect(await Promise.all([first, known, unknown, blocked])).toEqual([
      'stored',
      'stored',
      'held',
      'blocked',
    ]);
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(prisma.unallocatedTurbine.create).toHaveBeenCalledOnce();
    expect(events.publish).toHaveBeenCalledWith('unallocated-turbine.changed', {
      action: 'held',
      id: 'entry-1',
      turbineId: 'TURB999',
    });
  });

  it('publishes one telemetry.received per stored reading (not per turbine), only after the commit', async () => {
    const batcher = make();
    const order: string[] = [];
    events.publishMany.mockImplementation(() => {
      order.push('publish');
      return Promise.resolve([]);
    });
    prisma.$transaction.mockImplementation((async (
      fn: (tx: unknown) => unknown,
    ) => {
      const result = await fn(prisma);
      order.push('commit');
      return result;
    }) as never);

    // Same turbine, three readings: queued behind the first.
    hold = false;
    const results = [0, 5, 10].map((m) => batcher.submit(row('TURB001', m)));
    await Promise.all(results);

    const published = events.publishMany.mock.calls.flatMap(([items]) => items);
    expect(published).toHaveLength(3);
    expect(published.every((e) => e.type === TELEMETRY_RECEIVED)).toBe(true);
    expect(order.indexOf('publish')).toBeGreaterThan(order.indexOf('commit'));
    expect(order.filter((o) => o === 'commit').length).toBeGreaterThan(0);
  });

  it('writes nothing and publishes nothing when the transaction fails everywhere', async () => {
    const batcher = make();
    prisma.$transaction.mockRejectedValue(new Error('db down'));

    await expect(batcher.submit(row('TURB001'))).rejects.toThrow('db down');
    expect(events.publishMany).not.toHaveBeenCalled();
    expect(events.publish).not.toHaveBeenCalled();
  });

  it('retries a failed batch one reading at a time, so a bad reading fails alone with its own status', async () => {
    const batcher = make();
    prisma.unallocatedTurbine.count.mockResolvedValue(MAX_PENDING_UNALLOCATED);
    hold = true;
    const first = batcher.submit(row('TURB001', 0));
    const good = batcher.submit(row('TURB002', 5));
    const bad = batcher.submit(row('TURB999', 5)); // a new pair over the cap
    const good2 = batcher.submit(row('TURB003', 5));
    await vi.waitFor(() => expect(gates).toHaveLength(1));
    hold = false;
    gates[0]();

    const settled = await Promise.allSettled([first, good, bad, good2]);
    expect(settled.map((s) => s.status)).toEqual([
      'fulfilled',
      'fulfilled',
      'rejected',
      'fulfilled',
    ]);
    const rejected = settled[2] as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(BadRequestException);
    // 1 (first) + 1 failed batch + 3 singles.
    expect(prisma.$transaction).toHaveBeenCalledTimes(5);
    // The singles publish through the single-event path.
    expect(events.publish).toHaveBeenCalledTimes(2);
  });

  it('still acks when the live update fails (the data is committed)', async () => {
    const batcher = make();
    events.publishMany.mockRejectedValue(new Error('redis down'));

    await expect(batcher.submit(row('TURB001'))).resolves.toBe('stored');
    expect(prisma.telemetry.delete).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledOnce(); // no fallback for a Redis failure
  });

  describe('hard limit', () => {
    it('refuses with 503 when the queue is full, without writing, and warns at most once a minute', async () => {
      const batcher = make(100, 2);
      hold = true;
      const running = batcher.submit(row('TURB001', 0));
      const queued = [1, 2].map((m) => batcher.submit(row('TURB001', m)));
      await vi.waitFor(() => expect(gates).toHaveLength(1));

      const warn = vi.spyOn(Logger.prototype, 'warn');
      warn.mockClear();
      for (const m of [3, 4, 5]) {
        await expect(batcher.submit(row('TURB001', m))).rejects.toBeInstanceOf(
          QueueFullException,
        );
      }
      expect(warn).toHaveBeenCalledTimes(1);

      hold = false;
      gates[0]();
      await Promise.all([running, ...queued]);
      expect(inserted()).toEqual([1, 2]); // the rejected three never reached the database
    });

    it('answers 503 with Retry-After through the filter', () => {
      const res = {
        status: vi.fn().mockReturnThis(),
        set: vi.fn().mockReturnThis(),
        json: vi.fn(),
      };
      new QueueFullFilter().catch(new QueueFullException(2), {
        switchToHttp: () => ({ getResponse: () => res }),
      } as never);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.set).toHaveBeenCalledWith('Retry-After', '2');
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ statusCode: 503 }),
      );
    });
  });

  describe('shutdown', () => {
    it('finishes the queued readings, then refuses new ones', async () => {
      const batcher = make();
      hold = true;
      const results = [0, 5, 10].map((m) => batcher.submit(row('TURB001', m)));
      await vi.waitFor(() => expect(gates).toHaveLength(1));

      const closing = batcher.onModuleDestroy();
      await expect(batcher.submit(row('TURB001', 15))).rejects.toBeInstanceOf(
        QueueFullException,
      );
      hold = false;
      gates[0]();
      await closing;

      await expect(Promise.all(results)).resolves.toEqual([
        'stored',
        'stored',
        'stored',
      ]);
    });

    it('rejects what is still queued after the drain deadline (nothing hangs)', async () => {
      vi.useFakeTimers({ now: new Date('2026-03-01T00:00:00Z') });
      try {
        const batcher = make(1);
        hold = true;
        const running = batcher.submit(row('TURB001', 0));
        const queued = batcher.submit(row('TURB001', 5));
        await vi.waitFor(() => expect(gates).toHaveLength(1));
        const outcome = Promise.allSettled([running, queued]);

        const closing = batcher.onModuleDestroy();
        vi.setSystemTime(new Date('2026-03-01T00:01:00Z')); // past the deadline
        hold = false;
        gates[0]();
        await closing;

        const [a, b] = await outcome;
        expect(a.status).toBe('fulfilled');
        expect(b.status).toBe('rejected');
        expect((b as PromiseRejectedResult).reason).toBeInstanceOf(
          QueueFullException,
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
