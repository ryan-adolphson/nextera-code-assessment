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
  EventStore,
  compareEventIds,
  type AppEvent,
} from '@nextera/shared';
import { Redis } from 'ioredis';
import { Observable, Subject } from 'rxjs';

/**
 * Read side of the event bus, used only by the API: subscribes to the Redis channel that every
 * writer (API and ingestion worker) publishes to, and serves live / resumed streams for SSE.
 */
@Injectable()
export class EventsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(EventsService.name);
  private readonly subscriber: Redis; // a subscribed connection can't run other commands
  private readonly live$ = new Subject<AppEvent>();

  /** Emits once on shutdown so open SSE streams (and their heartbeats) end before the server closes. */
  readonly shutdown$ = new Subject<void>();

  constructor(
    config: ConfigService,
    private readonly store: EventStore,
  ) {
    this.subscriber = new Redis(config.getOrThrow<string>('REDIS_URL'));
  }

  async onModuleInit() {
    this.subscriber.on('message', (_channel: string, raw: string) => {
      try {
        this.live$.next(JSON.parse(raw) as AppEvent);
      } catch {
        this.logger.warn(`Dropping malformed event: ${raw}`);
      }
    });
    await this.subscriber.subscribe(EVENT_CHANNEL);
  }

  async onModuleDestroy() {
    this.shutdown$.next();
    this.shutdown$.complete();
    this.live$.complete();
    await this.subscriber.quit().catch(() => undefined);
  }

  /**
   * Live events. With a valid lastEventId, first replays what was missed, then continues live
   * without gaps or duplicates: live events that arrive during the replay are buffered, then
   * everything is filtered against the last delivered ID.
   */
  stream(lastEventId?: string): Observable<AppEvent> {
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
