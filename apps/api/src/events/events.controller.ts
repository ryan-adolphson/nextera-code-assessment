import {
  Controller,
  Header,
  Headers,
  MessageEvent,
  Query,
  Req,
  Sse,
} from '@nestjs/common';
import type { Socket } from 'node:net';
import {
  Observable,
  defer,
  interval,
  map,
  merge,
  takeUntil,
  timer,
} from 'rxjs';
import {
  AllowQueryToken,
  CurrentUser,
  Roles,
} from '../auth/auth.decorators.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { EVENT_ID_PATTERN } from '@nextera/shared';
import { EventsQueryDto } from './dto/events-query.dto.js';
import { EventsService, type WriteGate } from './events.service.js';

export const HEARTBEAT_MS = 15_000;

@Roles('viewer')
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  /**
   * GET /api/events (text/event-stream), optionally `?turbines=TURB001,TURB002` (at most 100).
   * Global events carry the Redis stream ID as `id`, so browsers resume with Last-Event-ID after a
   * disconnect or the Cloud Run 60-minute request limit; only those are replayed. The listed
   * turbines' `telemetry.received` readings are live only. They aren't in the stream, so they
   * have no id of their own; the SSE writer would invent a counter id for an event without one
   * and overwrite the browser's resume cursor, so a reading repeats the connection's last global
   * id (empty before the first). The client refetches its page after reconnecting.
   * EventSource can't send headers, so the access token may come as `?access_token=` (this route
   * only). The stream ends when that token expires; the browser then reconnects with a new one.
   */
  @Sse()
  @AllowQueryToken()
  @Header('X-Accel-Buffering', 'no')
  stream(
    @Headers('last-event-id') lastEventId?: string,
    @Query() query?: EventsQueryDto,
    @CurrentUser() user?: AuthenticatedUser,
    @Req() req?: { socket?: Socket },
  ): Observable<MessageEvent> {
    const events$ = defer(() => {
      let cursor =
        lastEventId && EVENT_ID_PATTERN.test(lastEventId) ? lastEventId : '';
      return this.events
        .stream(lastEventId, query?.turbines, socketGate(req?.socket))
        .pipe(
          map((e): MessageEvent => {
            if (e.id) cursor = e.id;
            return { id: e.id ?? cursor, type: e.type, data: e.data as object };
          }),
        );
    });

    // Keeps proxies and load balancers from closing an idle stream.
    const heartbeat$ = interval(HEARTBEAT_MS).pipe(
      map((): MessageEvent => ({ type: 'ping', data: '' })),
    );

    const end$ = user
      ? merge(this.events.shutdown$, timer(user.expiresAt))
      : this.events.shutdown$;
    return merge(events$, heartbeat$).pipe(takeUntil(end$));
  }
}

/**
 * Nest's SSE writer awaits each write, but it queues what the source emits meanwhile without
 * bound, so the source has to hold back itself: readings wait (bounded) while the socket is full.
 */
function socketGate(socket?: Socket): WriteGate | undefined {
  if (!socket) return undefined;
  return {
    blocked: () => socket.writableNeedDrain,
    onDrain: (callback) => {
      socket.once('drain', callback);
      return () => void socket.off('drain', callback);
    },
  };
}
