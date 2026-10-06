import { Injectable } from '@angular/core';
import { Observable } from 'rxjs';

export type SseStatus = 'connecting' | 'open' | 'reconnecting';

export type SseEvent<T> =
  { kind: 'status'; status: SseStatus } | { kind: 'message'; id: string; type: string; data: T };

/**
 * Wraps EventSource in an Observable: unsubscribing closes the connection.
 * The API sends NAMED events (`event: order.created`), so listeners are registered per type;
 * `onmessage` would only see unnamed events.
 * EventSource reconnects by itself after network errors and the Cloud Run 60-minute limit, sending
 * Last-Event-ID so the API replays what was missed; the stream only errors once it is fully CLOSED.
 */
@Injectable({ providedIn: 'root' })
export class SseService {
  connect<T>(url: string, types: readonly string[]): Observable<SseEvent<T>> {
    return new Observable<SseEvent<T>>((subscriber) => {
      const source = new EventSource(url);
      subscriber.next({ kind: 'status', status: 'connecting' });

      source.onopen = () => subscriber.next({ kind: 'status', status: 'open' });

      const onEvent = (event: MessageEvent<string>) =>
        subscriber.next({
          kind: 'message',
          id: event.lastEventId,
          type: event.type,
          data: JSON.parse(event.data) as T,
        });
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
