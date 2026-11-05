import { ConfigService } from '@nestjs/config';
import {
  FLEET_CHANGED,
  TELEMETRY_RECEIVED,
  type EventStore,
} from '@nextera/shared';
import { mockDeep } from 'vitest-mock-extended';
import { FarmsCacheService } from '../farms-cache/farms-cache.service.js';
import { EventsService } from './events.service.js';

type Handler = (channel: string, raw: string) => void;

const redis = vi.hoisted(() => ({
  handler: undefined as undefined | ((channel: string, raw: string) => void),
}));
vi.mock('ioredis', () => ({
  Redis: class {
    on(_event: string, handler: Handler) {
      redis.handler = handler;
    }
    subscribe = vi.fn().mockResolvedValue(1);
    quit = vi.fn().mockResolvedValue('OK');
  },
}));

describe('EventsService farms cache invalidation', () => {
  it('invalidates on fleet.changed before the event reaches stream subscribers, and only then', async () => {
    const farmsCache = mockDeep<FarmsCacheService>();
    const service = new EventsService(
      { getOrThrow: () => 'redis://x' } as unknown as ConfigService,
      mockDeep<EventStore>(),
      farmsCache,
    );
    await service.onModuleInit();
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
    emit(FLEET_CHANGED);

    expect(order).toEqual([TELEMETRY_RECEIVED, 'invalidate', FLEET_CHANGED]);
    await service.onModuleDestroy();
  });
});
