import { Controller, Header, Headers, MessageEvent, Sse } from '@nestjs/common';
import { Observable, interval, map, merge, takeUntil } from 'rxjs';
import { EventsService } from './events.service.js';

export const HEARTBEAT_MS = 15_000;

@Controller('events')
export class EventsController {
  constructor(private readonly events: EventsService) {}

  /**
   * GET /api/events (text/event-stream)
   * Named events (e.g. `telemetry.received`) carry the Redis stream ID as `id`, so browsers resume
   * with Last-Event-ID after a disconnect or the Cloud Run 60-minute request limit.
   */
  @Sse()
  @Header('X-Accel-Buffering', 'no')
  stream(
    @Headers('last-event-id') lastEventId?: string,
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

    return merge(events$, heartbeat$).pipe(takeUntil(this.events.shutdown$));
  }
}
