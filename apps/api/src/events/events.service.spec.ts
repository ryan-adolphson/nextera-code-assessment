import { ConfigService } from '@nestjs/config';
import {
  FLEET_CHANGED,
  FLEET_TICK,
  TELEMETRY_RECEIVED,
  type EventStore,
} from '@nextera/shared';
import { mockDeep } from 'vitest-mock-extended';
import { FarmsCacheService } from '../farms-cache/farms-cache.service.js';
import {
  EventsService,
  MAX_BUFFERED_READINGS,
  type LiveEvent,
  type WriteGate,
} from './events.service.js';

type Handler = (channel: string, raw: string) => void;

const redis = vi.hoisted(() => ({
  handler: undefined as undefined | ((channel: string, raw: string) => void),
  options: undefined as unknown,
  subscribe: undefined as unknown as ReturnType<typeof vi.fn>,
  unsubscribe: undefined as unknown as ReturnType<typeof vi.fn>,
}));
vi.mock('ioredis', () => ({
  Redis: class {
    constructor(_url: string, options: unknown) {
      redis.options = options;
      redis.subscribe = this.subscribe;
      redis.unsubscribe = this.unsubscribe;
    }
    on(_event: string, handler: Handler) {
      redis.handler = handler;
    }
    subscribe = vi.fn().mockResolvedValue(1);
    unsubscribe = vi.fn().mockResolvedValue(1);
    quit = vi.fn().mockResolvedValue('OK');
  },
}));

const reading = (turbineId: string, n = 0) =>
  JSON.stringify({
    type: TELEMETRY_RECEIVED,
    data: { turbineId, n },
  });
const emitReading = (turbineId: string, n = 0) =>
  redis.handler!(`telemetry:${turbineId}`, reading(turbineId, n));

async function create(farmsCache = mockDeep<FarmsCacheService>()) {
  const service = new EventsService(
    { getOrThrow: () => 'redis://x' } as unknown as ConfigService,
    mockDeep<EventStore>(),
    farmsCache,
  );
  await service.onModuleInit();
  return { service, farmsCache };
}

describe('EventsService farms cache invalidation', () => {
  it.each([FLEET_CHANGED, FLEET_TICK])(
    'invalidates on %s before the event reaches stream subscribers, and only then',
    async (invalidating) => {
      const { service, farmsCache } = await create();
      const order: string[] = [];
      farmsCache.invalidate.mockImplementation(
        () => void order.push('invalidate'),
      );
      service.stream().subscribe((e) => order.push(e.type));

      const emit = (type: string) =>
        redis.handler!(
          'events:live',
          JSON.stringify({ id: '1-0', type, data: {} }),
        );
      emit(TELEMETRY_RECEIVED);
      emit(invalidating);

      expect(order).toEqual([TELEMETRY_RECEIVED, 'invalidate', invalidating]);
      await service.onModuleDestroy();
    },
  );
});

describe('EventsService scoped readings', () => {
  it('delivers only the listed turbines, without an id, next to the global events', async () => {
    const { service } = await create();
    const got: LiveEvent[] = [];
    const sub = service
      .stream(undefined, ['A', 'B'])
      .subscribe((e) => got.push(e));

    emitReading('A', 1);
    emitReading('C', 2);
    redis.handler!(
      'events:live',
      JSON.stringify({ id: '9-0', type: FLEET_CHANGED, data: {} }),
    );
    emitReading('B', 3);

    expect(got).toEqual([
      { type: TELEMETRY_RECEIVED, data: { turbineId: 'A', n: 1 } },
      { id: '9-0', type: FLEET_CHANGED, data: {} },
      { type: TELEMETRY_RECEIVED, data: { turbineId: 'B', n: 3 } },
    ]);
    expect(got[0]).not.toHaveProperty('id');
    sub.unsubscribe();
    await service.onModuleDestroy();
  });

  it('subscribes no turbine channel without a turbines list', async () => {
    const { service } = await create();
    const sub = service.stream().subscribe();
    expect(redis.subscribe).toHaveBeenCalledTimes(1); // events:live only
    sub.unsubscribe();
    await service.onModuleDestroy();
  });

  it('reference-counts channels: subscribes on the first viewer, unsubscribes on the last', async () => {
    const { service } = await create();
    redis.subscribe.mockClear();
    const first = service.stream(undefined, ['A', 'B']).subscribe();
    const second = service.stream(undefined, ['B', 'B']).subscribe();

    expect(redis.subscribe.mock.calls).toEqual([
      ['telemetry:A'],
      ['telemetry:B'],
    ]);

    first.unsubscribe();
    expect(redis.unsubscribe.mock.calls).toEqual([['telemetry:A']]);
    expect(service.viewedTurbines).toEqual(['B']);

    const got: LiveEvent[] = [];
    const third = service
      .stream(undefined, ['B'])
      .subscribe((e) => got.push(e));
    emitReading('B');
    expect(got).toHaveLength(1);
    third.unsubscribe();
    expect(redis.unsubscribe).toHaveBeenCalledTimes(1); // second still views B

    second.unsubscribe();
    expect(redis.unsubscribe.mock.calls).toEqual([
      ['telemetry:A'],
      ['telemetry:B'],
    ]);
    expect(service.viewedTurbines).toEqual([]);

    emitReading('B'); // no listener left: ignored
    first.unsubscribe(); // idempotent
    expect(redis.unsubscribe).toHaveBeenCalledTimes(2);
    await service.onModuleDestroy();
  });

  it('subscribes again after the last viewer left and a new one came', async () => {
    const { service } = await create();
    redis.subscribe.mockClear();
    service.stream(undefined, ['A']).subscribe().unsubscribe();
    service.stream(undefined, ['A']).subscribe();
    expect(redis.subscribe).toHaveBeenCalledTimes(2);
    await service.onModuleDestroy();
  });

  it('keeps ioredis autoResubscribe on, so channels come back after a Redis reconnect', async () => {
    await create();
    expect(redis.options).toEqual({ autoResubscribe: true });
  });

  it(`holds at most ${MAX_BUFFERED_READINGS} readings per blocked connection and drops the oldest`, async () => {
    const { service } = await create();
    let blocked = true;
    let drain: (() => void) | undefined;
    const gate: WriteGate = {
      blocked: () => blocked,
      onDrain: (callback) => {
        drain = callback;
        return () => (drain = undefined);
      },
    };
    const got: LiveEvent[] = [];
    const sub = service
      .stream(undefined, ['A'], gate)
      .subscribe((e) => got.push(e));

    const total = MAX_BUFFERED_READINGS + 50;
    for (let n = 0; n < total; n++) emitReading('A', n);
    expect(got).toEqual([]);

    blocked = false;
    drain!();
    expect(got).toHaveLength(MAX_BUFFERED_READINGS);
    expect((got[0].data as { n: number }).n).toBe(50); // the 50 oldest were dropped
    expect((got.at(-1)!.data as { n: number }).n).toBe(total - 1);

    emitReading('A', 999); // gate open again: straight through
    expect(got).toHaveLength(MAX_BUFFERED_READINGS + 1);
    sub.unsubscribe();
    await service.onModuleDestroy();
  });

  it('stops waiting for a drain once the connection is gone', async () => {
    const { service } = await create();
    const cancel = vi.fn();
    const gate: WriteGate = { blocked: () => true, onDrain: () => cancel };
    const sub = service.stream(undefined, ['A'], gate).subscribe();
    emitReading('A');
    sub.unsubscribe();
    expect(cancel).toHaveBeenCalledOnce();
    await service.onModuleDestroy();
  });
});
