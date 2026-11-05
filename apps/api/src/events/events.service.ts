import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EVENT_CHANNEL,
  EVENT_ID_PATTERN,
  FLEET_CHANGED,
  FLEET_TICK,
  EventStore,
  compareEventIds,
  turbineChannel,
  type AppEvent,
} from '@nextera/shared';
import { Redis } from 'ioredis';
import { Observable, Subject, merge } from 'rxjs';
import { FarmsCacheService } from '../farms-cache/farms-cache.service.js';

/** An event on the SSE stream. Scoped readings have no stream id (they aren't in the stream). */
export interface LiveEvent {
  id?: string;
  type: string;
  data: unknown;
}

/**
 * What the transport can take right now. The scoped readings wait in the bounded buffer while it
 * says `blocked()` and flush on `onDrain`. Without one, readings are never held back.
 */
export interface WriteGate {
  blocked(): boolean;
  /** Calls `callback` once when writing can resume; returns a function that cancels it. */
  onDrain(callback: () => void): () => void;
}

/** Most scoped readings held for one connection while its socket is backed up; the oldest drop. */
export const MAX_BUFFERED_READINGS = 200;

const TURBINE_CHANNEL_PREFIX = turbineChannel('');

/**
 * Read side of the event bus, used only by the API: subscribes to the Redis channel that every
 * writer (API and ingestion worker) publishes to, and serves live / resumed streams for SSE.
 */
@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsService.name);
  private readonly subscriber: Redis; // a subscribed connection can't run other commands
  private readonly live$ = new Subject<AppEvent>();
  /** Per turbine, the connections viewing it on this instance; its size is the reference count. */
  private readonly viewers = new Map<string, Set<(event: LiveEvent) => void>>();

  /** Emits once on shutdown so open SSE streams (and their heartbeats) end before the server closes. */
  readonly shutdown$ = new Subject<void>();

  constructor(
    config: ConfigService,
    private readonly store: EventStore,
    private readonly farmsCache: FarmsCacheService,
  ) {
    // autoResubscribe (the default, explicit here): after a reconnect ioredis re-issues SUBSCRIBE
    // for every channel currently subscribed, including the per-turbine ones.
    this.subscriber = new Redis(config.getOrThrow<string>('REDIS_URL'), {
      autoResubscribe: true,
    });
  }

  async onModuleInit() {
    this.subscriber.on('message', (channel: string, raw: string) => {
      try {
        if (channel === EVENT_CHANNEL) {
          const event = JSON.parse(raw) as AppEvent;
          // Before the event reaches any SSE client: the web app reloads /api/farms on it and must
          // not get the cached, pre-change response. Runs on every instance (each has a subscriber).
          if (event.type === FLEET_CHANGED || event.type === FLEET_TICK) {
            this.farmsCache.invalidate();
          }
          this.live$.next(event);
        } else if (channel.startsWith(TURBINE_CHANNEL_PREFIX)) {
          const { type, data } = JSON.parse(raw) as LiveEvent;
          const turbineId = channel.slice(TURBINE_CHANNEL_PREFIX.length);
          this.viewers.get(turbineId)?.forEach((deliver) => {
            deliver({ type, data });
          });
        }
      } catch {
        this.logger.warn(`Dropping malformed event on ${channel}: ${raw}`);
      }
    });
    await this.subscriber.subscribe(EVENT_CHANNEL);
  }

  async onModuleDestroy() {
    this.shutdown$.next();
    this.shutdown$.complete();
    this.live$.complete();
    this.viewers.clear();
    await this.subscriber.quit().catch(() => undefined);
  }

  /** Turbines with at least one viewer on this instance (their Redis channels are subscribed). */
  get viewedTurbines(): string[] {
    return [...this.viewers.keys()];
  }

  /**
   * The SSE stream: every global event (ids from the Redis stream, replayed from `lastEventId`)
   * plus the live `telemetry.received` readings of `turbines` only. Readings are never replayed
   * and carry no id. Each connection that subscribes holds a reference on its turbines' channels
   * until it unsubscribes (disconnect, shutdown, token expiry), which releases them.
   */
  stream(
    lastEventId?: string,
    turbines: readonly string[] = [],
    gate?: WriteGate,
  ): Observable<LiveEvent> {
    const global$ = this.globalStream(lastEventId);
    return turbines.length
      ? merge(global$, this.readings(turbines, gate))
      : global$;
  }

  /** The readings of `turbines`, held in a bounded buffer per connection while the gate is shut. */
  private readings(
    turbines: readonly string[],
    gate?: WriteGate,
  ): Observable<LiveEvent> {
    return new Observable<LiveEvent>((subscriber) => {
      const queue: LiveEvent[] = [];
      let dropped = 0;
      let cancelDrain: (() => void) | undefined;

      const flush = () => {
        cancelDrain = undefined;
        while (queue.length && !subscriber.closed) {
          if (gate?.blocked()) {
            cancelDrain = gate.onDrain(flush);
            return;
          }
          subscriber.next(queue.shift()!);
        }
      };
      const deliver = (event: LiveEvent) => {
        if (queue.length >= MAX_BUFFERED_READINGS) {
          queue.shift();
          dropped++;
        }
        queue.push(event);
        if (!cancelDrain) flush();
      };

      const unique = [...new Set(turbines)];
      unique.forEach((id) => this.acquire(id, deliver));
      return () => {
        cancelDrain?.();
        unique.forEach((id) => this.release(id, deliver));
        if (dropped) {
          this.logger.warn(`Dropped ${dropped} readings for a slow SSE client`);
        }
      };
    });
  }

  private acquire(turbineId: string, deliver: (event: LiveEvent) => void) {
    let set = this.viewers.get(turbineId);
    if (!set) {
      set = new Set();
      this.viewers.set(turbineId, set);
      this.subscriber
        .subscribe(turbineChannel(turbineId))
        .catch((error: unknown) =>
          this.logger.warn(`Could not subscribe to ${turbineId}: ${error}`),
        );
    }
    set.add(deliver);
  }

  private release(turbineId: string, deliver: (event: LiveEvent) => void) {
    const set = this.viewers.get(turbineId);
    if (!set?.delete(deliver) || set.size) return;
    this.viewers.delete(turbineId);
    this.subscriber
      .unsubscribe(turbineChannel(turbineId))
      .catch((error: unknown) =>
        this.logger.warn(`Could not unsubscribe from ${turbineId}: ${error}`),
      );
  }

  /**
   * Global events. With a valid lastEventId, first replays what was missed, then continues live
   * without gaps or duplicates: live events that arrive during the replay are buffered, then
   * everything is filtered against the last delivered ID.
   */
  private globalStream(lastEventId?: string): Observable<AppEvent> {
    if (!lastEventId || !EVENT_ID_PATTERN.test(lastEventId)) {
      return this.live$.asObservable();
    }

    return new Observable<AppEvent>((subscriber) => {
      let cursor: string | null = null; // null while the replay is in flight
      const pending: AppEvent[] = [];

      const deliver = (event: AppEvent) => {
        if (cursor !== null && compareEventIds(event.id, cursor) > 0) {
          cursor = event.id;
          subscriber.next(event);
        }
      };

      const live = this.live$.subscribe({
        next: (event) =>
          cursor === null ? pending.push(event) : deliver(event),
        complete: () => subscriber.complete(),
      });

      this.store.since(lastEventId).then(
        (missed) => {
          cursor = lastEventId;
          [...missed, ...pending].forEach(deliver);
          pending.length = 0;
        },
        (error: unknown) => subscriber.error(error),
      );

      return () => live.unsubscribe();
    });
  }
}
