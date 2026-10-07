import { Controller, Header, Headers, MessageEvent, Sse } from '@nestjs/common';
import { Observable, interval, map, merge, takeUntil, timer } from 'rxjs';
import {
  AllowQueryToken,
  CurrentUser,
  Roles,
} from '../auth/auth.decorators.js';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { EventsService } from './events.service.js';

export const HEARTBEAT_MS = 15_000;

@Roles('viewer')
@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  /**
   * GET /api/events (text/event-stream)
   * Named events (e.g. `telemetry.received`) carry the Redis stream ID as `id`, so browsers resume
   * with Last-Event-ID after a disconnect or the Cloud Run 60-minute request limit.
   * EventSource can't send headers, so the access token may come as `?access_token=` (this route
   * only). The stream ends when that token expires; the browser then reconnects with a new one.
   */
  @Sse()
  @AllowQueryToken()
  @Header('X-Accel-Buffering', 'no')
  stream(
    @Headers('last-event-id') lastEventId?: string,
    @CurrentUser() user?: AuthenticatedUser,
  ): Observable<MessageEvent> {
    const events$ = this.events.stream(lastEventId).pipe(
      map((e): MessageEvent => ({
        id: e.id,
        type: e.type,
        data: e.data as object,
      })),
    );

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
