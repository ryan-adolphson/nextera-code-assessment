import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

export interface AppEvent {
  /** Redis stream ID ("<ms>-<seq>"), sent as the SSE `id` and used for Last-Event-ID resume. */
  id: string;
  type: string;
  data: unknown;
}

export const EVENT_STREAM_KEY = 'events:stream'; // durable history for replay
export const EVENT_CHANNEL = 'events:live'; // pub/sub fan-out to every API instance
export const EVENT_HISTORY_LENGTH = 1000;

/**
 * The pub/sub channel of one turbine's live readings (`telemetry.received`, published by ingestion
 * with `publishLive`, not stored in the stream). The scoped SSE endpoint subscribes to the
 * channels of the turbines a client is looking at.
 */
export const turbineChannel = (turbineId: string): string =>
  `telemetry:${turbineId}`;
export const EVENT_ID_PATTERN = /^\d+-\d+$/;

/** Orders Redis stream IDs ("<ms>-<seq>") numerically. */
export function compareEventIds(a: string, b: string): number {
  const [aMs, aSeq] = a.split('-').map(BigInt);
  const [bMs, bSeq] = b.split('-').map(BigInt);
  if (aMs !== bMs) return aMs < bMs ? -1 : 1;
  if (aSeq !== bSeq) return aSeq < bSeq ? -1 : 1;
  return 0;
}

/** Some events of `publishLive` were not published; the others went out. */
export class PublishManyError extends Error {
  override readonly name = 'PublishManyError';

  constructor(
    readonly failed: number,
    readonly total: number,
    override readonly cause?: Error,
  ) {
    super(
      `${failed} of ${total} events not published${cause ? `: ${cause.message}` : ''}`,
    );
  }
}

/**
 * Writes domain events for SSE. Used by every service that changes data (API and ingestion worker):
 * XADD to a capped Redis stream (history for Last-Event-ID replay), then PUBLISH so every API
 * instance pushes it to its connected clients.
 */
@Injectable()
export class EventStore implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor(config: ConfigService) {
    this.redis = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      maxRetriesPerRequest: 3,
    });
  }

  async onModuleDestroy() {
    await this.redis.quit().catch(() => undefined);
  }

  /** Call only after the corresponding database write has committed. */
  async publish(type: string, data: unknown): Promise<AppEvent> {
    const id = await this.redis.xadd(
      EVENT_STREAM_KEY,
      'MAXLEN',
      '~',
      EVENT_HISTORY_LENGTH,
      '*',
      'event',
      JSON.stringify({ type, data }),
    );
    const event: AppEvent = { id: id!, type, data };
    await this.redis.publish(EVENT_CHANNEL, JSON.stringify(event));
    return event;
  }

  /**
   * Publishes live events to their own channels in ONE pipelined round trip: a plain PUBLISH of
   * `{ type, data }` to `channel`, with no stream entry and no stream id. For high-volume events
   * (readings, `turbineChannel`) that would flood the capped stream and its replay history; a
   * subscriber that isn't listening just misses them. Call only after the database write has
   * committed. A partial failure throws `PublishManyError` (the others still went out).
   */
  async publishLive(
    items: readonly { channel: string; type: string; data: unknown }[],
  ): Promise<void> {
    if (!items.length) return;
    const pipeline = this.redis.pipeline();
    for (const { channel, type, data } of items) {
      pipeline.publish(channel, JSON.stringify({ type, data }));
    }
    const results = (await pipeline.exec()) ?? [];
    const errors: Error[] = [];
    items.forEach((_, i) => {
      const result = results[i];
      if (!result) errors.push(new Error('no pipeline result'));
      else if (result[0]) errors.push(result[0]);
    });
    if (errors.length) {
      throw new PublishManyError(errors.length, items.length, errors[0]);
    }
  }

  /** Events after `lastEventId` (exclusive), oldest first. */
  async since(lastEventId: string): Promise<AppEvent[]> {
    const entries = await this.redis.xrange(
      EVENT_STREAM_KEY,
      `(${lastEventId}`,
      '+',
      'COUNT',
      EVENT_HISTORY_LENGTH,
    );
    return entries.map(([id, fields]) => {
      const { type, data } = JSON.parse(fields[1]) as Omit<AppEvent, 'id'>;
      return { id, type, data };
    });
  }

  async ping(): Promise<string> {
    return this.redis.ping();
  }
}

@Global()
@Module({
  providers: [EventStore],
  exports: [EventStore],
})
export class EventStoreModule {}
