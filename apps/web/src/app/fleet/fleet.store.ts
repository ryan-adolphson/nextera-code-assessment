import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { secondsToMilliseconds } from 'date-fns';
import {
  BehaviorSubject,
  Subject,
  Subscription,
  catchError,
  defer,
  distinctUntilChanged,
  filter,
  forkJoin,
  map,
  of,
  retry,
  switchMap,
  tap,
  throwError,
  timer,
} from 'rxjs';
import { AuthStore } from '../core/auth/auth.store';
import { NOW } from '../core/clock';
import { SseEvent, SseService, SseStatus } from '../core/sse.service';
import { FleetApi, MAX_WATCHED_TURBINES, TelemetryWindow } from './fleet-api.service';
import {
  CLOCK_TICK_MS,
  DEFAULT_HISTORY_RANGE_MS,
  FARM_ROLLUP_COMPLETED,
  FLEET_TICK,
  FarmSummaryResponse,
  FleetSummaryResponse,
  LIVE_FUTURE_TOLERANCE_MS,
  MAX_HISTORY_READINGS,
  READING_INTERVAL_MS,
  TELEMETRY_EVENTS,
  Telemetry,
  TelemetryStats,
} from './fleet.model';
import { ALERT_CONFIG_CHANGED } from '../alerting/alert-config.model';
import { FLEET_CHANGED, UNALLOCATED_CHANGED } from '../unallocated/unallocated.model';
import { Staleness } from './staleness';

const FLEET_LOAD_ERROR = 'Could not load the fleet.';

/** Every SSE event type the shell's one connection listens for. */
const LIVE_EVENTS = [
  ...TELEMETRY_EVENTS,
  ALERT_CONFIG_CHANGED,
  UNALLOCATED_CHANGED,
  FLEET_CHANGED,
  FLEET_TICK,
  FARM_ROLLUP_COMPLETED,
];

/**
 * The live connection: `connecting` (first attempt), `open`, `reconnecting` (the browser's own
 * reconnect, or our backoff and the new connection after it) and `offline` (signed out: no more
 * retries; the sign-out flow takes over).
 */
export type LiveStatus = SseStatus | 'offline';

/** First wait before a new EventSource once the browser gave up on one; doubles per failure. */
export const RECONNECT_BASE_MS = secondsToMilliseconds(1);
/** The longest wait between reconnect attempts. */
export const RECONNECT_MAX_MS = secondsToMilliseconds(30);

/**
 * Wait before reconnect attempt `failures + 1`: 1 s, 2 s, 4 s … capped at 30 s, minus up to half
 * of it at random (`random` in [0, 1)), so browsers that lost the API together don't all return at
 * once.
 */
export function reconnectDelayMs(failures: number, random = Math.random()): number {
  const capped = Math.min(RECONNECT_MAX_MS, RECONNECT_BASE_MS * 2 ** failures);
  return Math.round(capped * (1 - random / 2));
}

/** How long a turbine counts as just updated: the row's flash (`--animate-flash` in styles.css). */
export const FLASH_MS = secondsToMilliseconds(2);

/** Fleet totals as the overview shows them (zeros until the first summary arrives). */
export interface FleetTotals {
  farms: number;
  turbines: number;
  commissioned: number;
  reporting: number;
  stale: number;
  alerting: number;
  powerKw: number;
  /** The summary's own time (ISO, UTC); null before the first reading or summary. */
  asOf: string | null;
}

/** A farm's server-side totals; `staleness` is derived (see `FleetStore.farms`). */
export interface FarmSummary {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  turbineCount: number;
  commissioned: number;
  /** Turbines reporting; output and wind only count these. */
  reporting: number;
  stale: number;
  alerting: number;
  /**
   * 'ok' if any turbine reports, 'stale-15' if none does but some are stale (the summary doesn't
   * say for how long), 'empty' if none ever reported or the farm has no turbines.
   */
  staleness: Staleness;
  powerKw: number;
  avgWindMs: number | null;
  asOf: string | null;
}

const sameIds = (a: readonly string[], b: readonly string[]) => key(a) === key(b);
const key = (ids: readonly string[]) => [...ids].sort().join(',');

function toFarmSummary(farm: FarmSummaryResponse): FarmSummary {
  return {
    id: farm.id,
    name: farm.name,
    latitude: farm.latitude,
    longitude: farm.longitude,
    turbineCount: farm.turbineCount,
    commissioned: farm.commissioned,
    reporting: farm.reporting,
    stale: farm.stale,
    alerting: farm.alerting,
    staleness: farm.reporting > 0 ? 'ok' : farm.stale > 0 ? 'stale-15' : 'empty',
    powerKw: farm.powerOutputKw,
    avgWindMs: farm.windSpeedMs,
    asOf: farm.asOf,
  };
}

/**
 * Fleet state for the shell: the fleet and farm summaries (rebuilt by the server about once a
 * minute, refreshed on `fleet.tick` and `fleet.changed`), the one live connection, the clock, and
 * the selected turbine's history. It holds no per-turbine lists: tables page through the API
 * (`TurbinePageStore`) and tell this store which turbines are on screen (`watchTurbines`), so the
 * connection carries only their readings (`readings$`). Readings arrive late and out of order, so
 * everything is keyed by measurement time.
 */
@Injectable()
export class FleetStore {
  private readonly api = inject(FleetApi);
  private readonly sse = inject(SseService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly clock = inject(NOW);
  private readonly auth = inject(AuthStore);

  private readonly fleetSummary = signal<FleetSummaryResponse | null>(null);
  private readonly farmSummaries = signal<FarmSummaryResponse[]>([]);
  private historySub?: Subscription;
  private summariesSub?: Subscription;
  /** The selected turbine's loaded and live readings, newest first (may extend past the window). */
  private readonly loadedHistory = signal<Telemetry[]>([]);
  /** Live readings received while the history request is pending (merged into its response). */
  private liveWhileLoading: Telemetry[] = [];
  private tickTimer?: ReturnType<typeof setTimeout>;

  /** Who watches which turbines (a table's page, the selected turbine): the union is on the wire. */
  private readonly watchers = new Map<object, readonly string[]>();
  private readonly watched$ = new BehaviorSubject<readonly string[]>([]);
  private readonly historyWatcher = {};
  private readonly readingsSubject = new Subject<Telemetry>();
  /**
   * Live readings for the watched turbines (none from the future): consumers apply what they show.
   */
  readonly readings$ = this.readingsSubject.asObservable();

  /**
   * The client time (epoch ms): the reference for staleness and the end of the selected turbine's
   * window. Re-read on `init`, every `CLOCK_TICK_MS` (aligned to the minute) while the store
   * lives, on every select and on every live reading for the selected turbine.
   */
  readonly now = signal(this.clock());

  readonly liveStatus = signal<LiveStatus>('connecting');
  /**
   * Bumped on every `alert-config.changed` event (an alert rule was created, edited or deleted,
   * here or in another browser): pages showing rules reload when it changes.
   */
  readonly alertConfigVersion = signal(0);
  /**
   * Bumped on every `farm-rollup.completed` event (the farm rollup committed, every 15 min) and
   * after a resync (a missed event): the farm History tab reloads and its cache entries from an
   * earlier version count as misses.
   */
  readonly farmRollupVersion = signal(0);
  /**
   * Bumped on every `unallocated-turbine.changed` event (an entry was held, resolved, blocked or
   * unblocked) and after a resync: the Unallocated pages reload when it changes.
   */
  readonly unallocatedVersion = signal(0);
  /**
   * Bumped on every `fleet.changed` event (a turbine was assigned, moved or commissioned, here or
   * elsewhere) and `reloadFleet()`: tables reload their page when it changes.
   */
  readonly fleetVersion = signal(0);
  /** Bumped each time the summaries were loaded (first load, tick, change, resync): maps refresh. */
  readonly summaryVersion = signal(0);
  /**
   * Bumped each time a live connection opens (the first, a new one for other watched turbines, an
   * outage reconnect, the browser's own): readings published before the subscription are not
   * replayed, so tables refetch their page when it changes.
   */
  readonly streamOpens = signal(0);
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  /**
   * The summaries finished loading and no error is showing, so `farms` can be trusted: a farm
   * missing from it really doesn't exist. After a failed load the list is just empty.
   */
  readonly fleetLoadedOk = computed(() => !this.loading() && !this.error());
  readonly selectedTurbineId = signal<string | null>(null);
  readonly historyLoading = signal(false);
  readonly historyRangeMs = signal(DEFAULT_HISTORY_RANGE_MS);
  private historyLimit = MAX_HISTORY_READINGS;
  /**
   * Median/high/low per metric over the selected turbine's range (the same window as `history`),
   * or null while unknown or if the request failed (the charts then just show no reference lines).
   */
  readonly stats = signal<TelemetryStats | null>(null);
  /** Stats to load (null = none). switchMap cancels a pending request, so stale ones never win. */
  private readonly statsRequests = new Subject<{
    turbineId: string;
    window: TelemetryWindow;
  } | null>();

  constructor() {
    this.statsRequests
      .pipe(
        switchMap((request) =>
          request
            ? this.api
                .telemetryStats(request.turbineId, request.window)
                .pipe(catchError(() => of(null)))
            : of(null),
        ),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe((stats) => this.stats.set(stats));
    this.destroyRef.onDestroy(() => this.stopTicking());
  }

  /** "Data as of" (epoch ms): the fleet summary's time, or null before there is one. */
  readonly fleetTime = computed(() => {
    const asOf = this.fleetSummary()?.asOf;
    return asOf ? Date.parse(asOf) : null;
  });

  /** The fleet totals from the last summary. */
  readonly fleet = computed<FleetTotals>(() => {
    const f = this.fleetSummary();
    return {
      farms: f?.farms ?? 0,
      turbines: f?.turbines ?? 0,
      commissioned: f?.commissioned ?? 0,
      reporting: f?.reporting ?? 0,
      stale: f?.stale ?? 0,
      alerting: f?.alerting ?? 0,
      powerKw: f?.powerOutputKw ?? 0,
      asOf: f?.asOf ?? null,
    };
  });

  /** Every farm with its totals, as of the last summary (no turbines). */
  readonly farms = computed<FarmSummary[]>(() => this.farmSummaries().map(toFarmSummary));

  /**
   * Starts the minute clock (staleness advances on every page without user interaction), opens the
   * live connection first, then loads the summaries: nothing that happens in between is missed.
   */
  init(): void {
    this.now.set(this.clock());
    this.startTicking();
    this.connectLive();
    this.loadSummaries({ quiet: false });
  }

  /**
   * Says which turbines `owner` shows (replacing its earlier list; none = stops watching). The
   * connection carries the readings of all watchers' turbines (at most 100): when the set changes
   * it reconnects, without a visible status change.
   */
  watchTurbines(owner: object, ids: readonly string[]): void {
    if (ids.length) this.watchers.set(owner, ids.slice(0, MAX_WATCHED_TURBINES));
    else this.watchers.delete(owner);
    const union = [...new Set([...this.watchers.values()].flat())].slice(0, MAX_WATCHED_TURBINES);
    this.watched$.next(union);
  }

  /**
   * The live connection, kept up while the store lives; a new one for each change of the watched
   * turbines (`watchTurbines`). The browser reconnects an EventSource by itself after a network
   * drop or the end of a stream (sending Last-Event-ID, so the API replays the fleet-wide events
   * missed), but gives up for good when a reconnect gets an HTTP error (a 503 during a deploy, a
   * 502 from a proxy, a 401): SseService then errors. Here that means: `reconnecting`, wait
   * `reconnectDelayMs` (1 s, 2 s, 4 s … 30 s, jittered; back to 1 s after an open), then a new
   * EventSource with a freshly read URL (the token may have changed). A new EventSource can't send
   * Last-Event-ID, so when one of ours opens after an outage, `resync()` reloads what it may have
   * missed. Signed out (e.g. the session expired): no more attempts, `offline`.
   */
  private connectLive(): void {
    let first = true;
    this.watched$
      .pipe(
        distinctUntilChanged(sameIds),
        switchMap((ids) => {
          const switched = !first;
          first = false;
          return this.liveConnection(ids, switched);
        }),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({
        next: (event) => {
          if (event.kind === 'status') this.liveStatus.set(event.status);
          else if (event.type === ALERT_CONFIG_CHANGED)
            this.alertConfigVersion.update((v) => v + 1);
          else if (event.type === UNALLOCATED_CHANGED) this.unallocatedVersion.update((v) => v + 1);
          else if (event.type === FLEET_CHANGED) this.reloadFleet();
          else if (event.type === FLEET_TICK) this.loadSummaries({ quiet: true });
          else if (event.type === FARM_ROLLUP_COMPLETED)
            this.farmRollupVersion.update((v) => v + 1);
          else this.receive(event.data as Telemetry);
        },
        error: () => this.liveStatus.set('offline'),
      });
  }

  /**
   * One EventSource for `ids`, retried with backoff. `switched`: it replaces an open connection
   * because the watched turbines changed, so its `connecting` status is not shown and its open
   * only refreshes the summaries (the fleet-wide events in the gap are not replayed). A retry after
   * a failure is an outage reconnect either way.
   *
   * (`retry`'s `resetOnSuccess` doesn't fit: every attempt emits `connecting` at once, which would
   * reset the count before the connection ever opened; `failures` is reset on `open` instead.)
   */
  private liveConnection(ids: readonly string[], switched: boolean) {
    let failures = 0;
    let attempts = 0;
    return defer(() => {
      if (!this.auth.isAuthenticated()) return throwError(() => new Error('Signed out'));
      const outage = attempts++ > 0;
      const quietSwitch = switched && !outage;
      let opened = false;
      return this.sse.connect<unknown>(this.api.eventsUrl(ids), LIVE_EVENTS).pipe(
        // A retry's new connection is still "Reconnecting…" until it opens, not "Connecting…".
        map((event): SseEvent<unknown> | null => {
          if (event.kind !== 'status' || event.status !== 'connecting') return event;
          if (outage) return { kind: 'status', status: 'reconnecting' };
          return quietSwitch ? null : event;
        }),
        filter((event): event is SseEvent<unknown> => event !== null),
        tap((event) => {
          if (event.kind !== 'status' || event.status !== 'open') return;
          failures = 0;
          this.streamOpens.update((v) => v + 1);
          // Only the first open of our new EventSource: later opens are the browser's own
          // reconnects, which resume with Last-Event-ID.
          if (!opened) {
            if (outage) this.resync();
            else if (quietSwitch) this.loadSummaries({ quiet: true });
          }
          opened = true;
        }),
      );
    }).pipe(
      retry({
        delay: (error: unknown) => {
          if (!this.auth.isAuthenticated()) return throwError(() => error);
          this.liveStatus.set('reconnecting');
          return timer(reconnectDelayMs(failures++));
        },
      }),
    );
  }

  /**
   * After our own reconnect following an outage: the API replays nothing to a new EventSource, so
   * reload what the outage may have missed. The live stream is already open, so nothing arriving
   * from now on is lost: the summaries, the selected turbine's history and stats (same range,
   * kept on screen while they reload), the rule pages (missed `alert-config.changed`), the
   * Unallocated pages (missed `unallocated-turbine.changed`). The tables refetch on `streamOpens`.
   */
  private resync(): void {
    this.loadSummaries({ quiet: true });
    const selected = this.selectedTurbineId();
    if (selected) this.select(selected);
    this.alertConfigVersion.update((v) => v + 1);
    this.farmRollupVersion.update((v) => v + 1);
    this.unallocatedVersion.update((v) => v + 1);
  }

  /**
   * The fleet changed on the server (`fleet.changed`: a turbine was assigned, moved or
   * commissioned, or this browser just did that): reloads the summaries quietly and tells the
   * tables to reload their page (`fleetVersion`).
   */
  reloadFleet(): void {
    this.fleetVersion.update((v) => v + 1);
    this.loadSummaries({ quiet: true });
  }

  /**
   * Loads the fleet and farm summaries (replacing a pending load). The first load drives
   * `loading`/`error`; a quiet one (tick, change, resync) once that finished updates them without
   * a trace: a failure keeps what is shown, a success clears a failed first load's error.
   */
  private loadSummaries({ quiet }: { quiet: boolean }): void {
    const silent = quiet && !this.loading();
    this.summariesSub?.unsubscribe();
    this.summariesSub = forkJoin({
      fleet: this.api.fleetSummary(),
      farms: this.api.farmSummaries(),
    })
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: ({ fleet, farms }) => {
          this.fleetSummary.set(fleet);
          this.farmSummaries.set(farms);
          this.loading.set(false);
          if (this.error() === FLEET_LOAD_ERROR) this.error.set(null);
          this.summaryVersion.update((v) => v + 1);
        },
        error: () => {
          if (silent) return;
          this.error.set(FLEET_LOAD_ERROR);
          this.loading.set(false);
        },
      });
  }

  /**
   * The selected turbine's chart window: `range` ending at the client's current time (`now`), so
   * it slides with the clock even when no readings arrive. Null when no turbine is selected.
   */
  readonly historyWindow = computed(() => {
    if (!this.selectedTurbineId()) return null;
    const to = this.now();
    return { from: to - this.historyRangeMs(), to };
  });

  /**
   * The selected turbine's readings inside `historyWindow`, newest first by measurement time.
   * Readings drop off as the window slides past them.
   */
  readonly history = computed(() => {
    const window = this.historyWindow();
    if (!window) return [];
    return this.loadedHistory().filter((r) => {
      const t = Date.parse(r.timestamp);
      return t >= window.from && t <= window.to;
    });
  });

  /**
   * Loads the turbine's readings for the range (default: the current range). Changing only the
   * range keeps the previous readings on screen until the new ones arrive (no empty flash).
   */
  select(turbineId: string | null, rangeMs = this.historyRangeMs()): void {
    const sameTurbine = turbineId === this.selectedTurbineId();
    this.selectedTurbineId.set(turbineId);
    this.historyRangeMs.set(rangeMs);
    this.historySub?.unsubscribe();
    this.liveWhileLoading = [];
    if (!turbineId) {
      this.loadedHistory.set([]);
      this.historyLoading.set(false);
      this.statsRequests.next(null);
      this.watchTurbines(this.historyWatcher, []);
      return;
    }
    if (!sameTurbine) {
      this.loadedHistory.set([]);
      this.stats.set(null); // another turbine's stats must never show; same turbine: keep until new
    }
    this.watchTurbines(this.historyWatcher, [turbineId]);

    this.now.set(this.clock());
    this.historyLimit = Math.min(
      MAX_HISTORY_READINGS,
      Math.ceil(rangeMs / READING_INTERVAL_MS) + 1,
    );
    const window = this.requestWindow();
    this.statsRequests.next({ turbineId, window });
    this.historyLoading.set(true);
    this.historySub = this.api
      .telemetry(turbineId, window)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (readings) => {
          // Keep live readings pushed while loading (the response may predate them).
          const live = this.liveWhileLoading;
          this.liveWhileLoading = [];
          this.loadedHistory.set(mergeHistory([...live, ...readings], this.historyLimit));
          this.historyLoading.set(false);
        },
        error: () => {
          this.error.set(`Could not load telemetry for ${turbineId}.`);
          this.historyLoading.set(false);
        },
      });
  }

  /**
   * A live reading: passed on to `readings$` and, for the selected turbine, merged into its
   * history. Ignored (with a console warning) when dated more than `LIVE_FUTURE_TOLERANCE_MS`
   * ahead of the client clock. Ingestion rejects that already; this keeps a bad event from moving
   * the highlight, staleness or the charts. The API sends only watched turbines' readings; each
   * consumer drops what it doesn't show.
   */
  private receive(reading: Telemetry): void {
    if (Date.parse(reading.timestamp) > this.clock() + LIVE_FUTURE_TOLERANCE_MS) {
      console.warn(
        `Ignoring a live reading for ${reading.turbineId} dated in the future: ${reading.timestamp}`,
      );
      return;
    }
    this.readingsSubject.next(reading);
    if (reading.turbineId !== this.selectedTurbineId()) return;
    this.now.set(this.clock());
    // A late reading older than the window is not charted and cannot change the range's stats.
    if (Date.parse(reading.timestamp) < this.now() - this.historyRangeMs()) return;
    if (this.historyLoading()) this.liveWhileLoading.push(reading);
    this.loadedHistory.update((current) => mergeHistory([reading, ...current], this.historyLimit));
    // The reading changes the range's stats: reload them for the (possibly slid) window.
    this.statsRequests.next({ turbineId: reading.turbineId, window: this.requestWindow() });
  }

  /**
   * The API query for the selected range ending now (the history and stats requests). `to` is
   * left open: the API's `to` is exclusive, and a reading measured at the current 5-minute
   * boundary must be included even if this clock runs a little behind the turbines'. The chart
   * still ends at `now`.
   */
  private requestWindow(): TelemetryWindow {
    return {
      from: new Date(this.now() - this.historyRangeMs()).toISOString(),
      limit: this.historyLimit,
    };
  }

  /**
   * Re-reads the clock: updates staleness everywhere and slides the selected turbine's
   * window. Reloads the stats only when that changed which readings are in the window (one
   * left, or one dated slightly ahead of this clock entered).
   */
  private tick(): void {
    const id = this.selectedTurbineId();
    const before = windowKey(this.history());
    this.now.set(this.clock());
    if (id && windowKey(this.history()) !== before) {
      this.statsRequests.next({ turbineId: id, window: this.requestWindow() });
    }
  }

  /**
   * Ticks on every minute boundary (re-aligned each time, so timer drift never accumulates), from
   * `init` until the store is destroyed (the FleetShell's lifetime). One timer, however often
   * `init` or `select` run.
   */
  private startTicking(): void {
    if (this.tickTimer !== undefined) return;
    const schedule = () => {
      this.tickTimer = setTimeout(
        () => {
          this.tick();
          schedule();
        },
        CLOCK_TICK_MS - (this.clock() % CLOCK_TICK_MS),
      );
    };
    schedule();
  }

  private stopTicking(): void {
    clearTimeout(this.tickTimer);
    this.tickTimer = undefined;
  }
}

/** Identifies which readings a (sorted) window holds: they only enter or leave at the ends. */
function windowKey(readings: Telemetry[]): string {
  return `${readings.length}:${readings[0]?.id}:${readings.at(-1)?.id}`;
}

/** Newest first by measurement time, one entry per reading, capped to `limit`. */
function mergeHistory(readings: Telemetry[], limit: number): Telemetry[] {
  const byId = new Map(readings.map((r) => [r.id, r]));
  return [...byId.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, limit);
}
