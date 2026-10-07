import { Signal, computed, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { Observable, tap } from 'rxjs';

/** A request whose latest answer is kept as signals. */
export interface LatestLoad<Req, Res> {
  /** The last successful answer (kept when a later request fails); null before the first. */
  readonly value: Signal<Res | null>;
  readonly loading: Signal<boolean>;
  /** The latest request failed (the previous `value` is still there). */
  readonly failed: Signal<boolean>;
  /** Sends a request; an answer to an earlier one still in flight is dropped. */
  run(request: Req): void;
  /** Sends the last request again (after a failure; ignored while a request is in flight). */
  retry(): void;
}

/**
 * Loads with `load(request)` through an `rxResource`, keeping only the latest request's answer,
 * as signals. A failure only sets `failed`; the next `run` or `retry` loads again. `onLoad` runs
 * after each successful answer is stored (e.g. back to the first page). Call it in an injection
 * context (a field initializer or constructor): the resource ends with the component.
 *
 * The request is sent on the next change detection (the resource's params are a signal), and the
 * resource holds a PendingTasks entry while it loads, so `whenStable()` waits for the answer.
 */
export function latestLoad<Req, Res>(
  load: (request: Req) => Observable<Res>,
  onLoad?: (value: Res) => void,
): LatestLoad<Req, Res> {
  // Wrapped, so running the same request again is a new params value and loads again.
  const params = signal<{ request: Req } | undefined>(undefined);
  // A plain signal set by the stream, not derived from the resource: the resource's value is
  // reset by the next request (and throws after an error), and a lazily derived copy could miss
  // an answer nobody read. New params unsubscribe the old stream, so stale answers never get here.
  const value = signal<Res | null>(null);

  const resource = rxResource({
    params,
    stream: ({ params: { request } }) =>
      load(request).pipe(
        tap((answer) => {
          value.set(answer);
          onLoad?.(answer);
        }),
      ),
  });

  return {
    value: value.asReadonly(),
    loading: resource.isLoading,
    failed: computed(() => resource.status() === 'error'),
    run: (request) => params.set({ request }),
    retry: () => resource.reload(),
  };
}
