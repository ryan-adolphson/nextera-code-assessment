import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export type SseStatus = 'connecting' | 'open' | 'reconnecting';

export type SseEvent<T> =
  { kind: 'status'; status: SseStatus } | { kind: 'message'; id: string; type: string; data: T };

/**
 * Wraps EventSource in an Observable: unsubscribing closes the connection.
 * The API sends NAMED events (`event: order.created`), so listeners are registered per type;
 * `onmessage` would only see unnamed events.
 * One subscription = one EventSource. It reconnects by itself after network errors and the Cloud
 * Run 60-minute limit (status `reconnecting`, then `open` again), sending Last-Event-ID so the API
 * replays what was missed. But when a (re)connect gets an HTTP error or a non-event-stream response
 * (a 503 during a deploy or cold start, a 502 from a proxy, a 401 for an expired token), the browser
 * fails the connection for good (readyState CLOSED, no more retries): the Observable then errors.
 * Retrying is the caller's job, with a new subscription (a new EventSource, which can't send
 * Last-Event-ID, so the caller must reload what it may have missed): see `FleetStore.connectLive`.
 * An event whose data isn't valid JSON is skipped with a `console.warn` (type and id, not the
 * payload): nothing is emitted, the stream stays open, and nothing throws inside the listener.
 */
@Injectable({ providedIn: 'root' })
export class SseService {
  connect<T>(url: string, types: readonly string[]): Observable<SseEvent<T>> {
    return new Observable<SseEvent<T>>((subscriber) => {
      const source = new EventSource(url);
      subscriber.next({ kind: 'status', status: 'connecting' });

      source.onopen = () => subscriber.next({ kind: 'status', status: 'open' });

      const onEvent = (event: MessageEvent<string>) => {
        let data: T;
        try {
          data = JSON.parse(event.data) as T;
        } catch {
          console.warn(
            `Skipped SSE event "${event.type}" (id ${event.lastEventId}): data is not valid JSON`,
          );
          return;
        }
        subscriber.next({ kind: 'message', id: event.lastEventId, type: event.type, data });
      };
      types.forEach((type) => source.addEventListener(type, onEvent));

      source.onerror = () => {
        if (source.readyState === EventSource.CLOSED) {
          subscriber.error(new Error('Live updates disconnected'));
        } else {
          subscriber.next({ kind: 'status', status: 'reconnecting' });
        }
      };

      return () => source.close();
    });
  }
}
