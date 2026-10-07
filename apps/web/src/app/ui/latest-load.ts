import { Signal, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Observable, Subject, catchError, map, of, switchMap, tap } from 'rxjs';

/** A request whose latest answer is kept as signals. */
export interface LatestLoad<Req, Res> {
  /** The last successful answer (kept when a later request fails); null before the first. */
  readonly value: Signal<Res | null>;
  readonly loading: Signal<boolean>;
  /** The latest request failed (the previous `value` is still there). */
  readonly failed: Signal<boolean>;
  /** Sends a request; an answer to an earlier one still in flight is dropped (`switchMap`). */
  run(request: Req): void;
  /** Sends the last request again (after a failure). */
  retry(): void;
}

/**
 * Loads with `load(request)`, keeping only the latest request's answer, as signals. Errors are
 * caught (`failed`), so one failure never ends the stream. `onLoad` runs after each successful
 * answer is stored (e.g. back to the first page). Call it in an injection context (a field
 * initializer or constructor): the subscription ends with the component.
 */
export function latestLoad<Req, Res>(
  load: (request: Req) => Observable<Res>,
  onLoad?: (value: Res) => void,
): LatestLoad<Req, Res> {
  const value = signal<Res | null>(null);
  const loading = signal(false);
  const failed = signal(false);
  const requests = new Subject<Req>();
  let last: { request: Req } | null = null;

  requests
    .pipe(
      tap((request) => {
        last = { request };
        loading.set(true);
        failed.set(false);
      }),
      switchMap((request) =>
        load(request).pipe(
          map((result) => ({ ok: true as const, result })),
          catchError(() => of({ ok: false as const })),
        ),
      ),
      takeUntilDestroyed(),
    )
    .subscribe((answer) => {
      if (answer.ok) {
        value.set(answer.result);
        onLoad?.(answer.result);
      } else {
        failed.set(true);
      }
      loading.set(false);
    });

  return {
    value: value.asReadonly(),
    loading: loading.asReadonly(),
    failed: failed.asReadonly(),
    run: (request) => requests.next(request),
    retry: () => {
      if (last) requests.next(last.request);
    },
  };
}
