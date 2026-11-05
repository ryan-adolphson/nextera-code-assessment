import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { secondsToMilliseconds } from 'date-fns';
import { AuthStore } from '../core/auth/auth.store';
import { errorMessage, statusOf } from '../core/http-errors';
import { latestLoad } from '../ui/latest-load';
import { cursorPaging } from '../ui/paging';
import { FleetApi } from './fleet-api.service';
import {
  METRIC_SORT_KEYS,
  Telemetry,
  TurbineItem,
  TurbinePageResponse,
  TurbineQuery,
  TurbineSortKey,
  TurbineStatus,
} from './fleet.model';
import { FLASH_MS, FleetStore } from './fleet.store';
import { Staleness, stalenessOf } from './staleness';

/** A typed filter is sent this long after the last keystroke. */
export const FILTER_DEBOUNCE_MS = 300;
/** Live readings for the page are applied in one update per this long. */
export const LIVE_BATCH_MS = secondsToMilliseconds(1);
/** The visible turbines are sent to the live connection this long after they last changed. */
export const WATCH_DEBOUNCE_MS = 300;
const MINUTE_MS = 60_000;
export const TURBINE_PAGE_SIZE = 25;
/** Filtered totals above this show as "10,000+" (the API counts up to 10,001). */
export const TOTAL_DISPLAY_CAP = 10_000;

export type StatusFilter = 'all' | TurbineStatus;
export type CommissionedFilter = 'all' | 'yes' | 'no';
export interface TurbineSort {
  key: TurbineSortKey;
  dir: 'asc' | 'desc';
}

/** A row of the table: the server's item plus the client-clock staleness (4 levels, not 3). */
export interface TurbineRow extends TurbineItem {
  staleness: Staleness;
}

/** Sort keys whose value a live reading changes: the batch re-orders the page by them. */
const LIVE_SORT_KEYS: readonly TurbineSortKey[] = ['time', 'power', 'wind', 'gearbox'];

const SORT_VALUE: Record<
  'time' | 'power' | 'wind' | 'gearbox',
  (t: TurbineItem) => string | number | null
> = {
  time: (t) => t.latest?.timestamp ?? null,
  power: (t) => t.latest?.powerOutputKw ?? null,
  wind: (t) => t.latest?.windSpeedMs ?? null,
  gearbox: (t) => t.latest?.gearboxTempC ?? null,
};

/** Why a commissioned change failed, in words (the API's 404 text names no reason). */
export function commissionedErrorMessage(
  error: unknown,
  turbineId: string,
  commissioned: boolean,
): string {
  const reason =
    statusOf(error) === 404
      ? 'The turbine no longer exists, or your account can no longer change it.'
      : errorMessage(error);
  return `Could not mark ${turbineId} as ${commissioned ? 'commissioned' : 'not commissioned'}. ${reason}`;
}

const sameIds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((id, i) => id === b[i]);

/**
 * One turbines table's server-side state (provided by the table component, one per table): the
 * filters, the sort, the cursor and the one page of rows they give (`GET /api/turbines`).
 *
 * - **Loading**: a change of query sends one request (`latestLoad`: a request replaces the one in
 *   flight, so a stale answer never lands). Typed text waits `FILTER_DEBOUNCE_MS`; selects and
 *   switches apply at once. Every change goes back to the first page.
 * - **Live**: the page's ids go to `FleetStore.watchTurbines` (debounced), so the one connection
 *   carries only their readings. Readings are batched into one update per `LIVE_BATCH_MS`; only a
 *   reading newer than the row's latest counts, and readings for turbines not on the page are
 *   dropped. Rows keep their place, unless the sort is by a value readings change (last reading,
 *   power, wind, gearbox): then the batch re-orders the page (`reorderWith` lets the table animate
 *   it). The page is fetched again each time the stream opens (no replay of readings) and on `fleet.changed`.
 * - **Commissioned**: optimistic, one request per turbine at a time, back to the server's value on
 *   failure (`commissionedError`).
 */
@Injectable()
export class TurbinePageStore {
  private readonly api = inject(FleetApi);
  private readonly fleet = inject(FleetStore);
  private readonly auth = inject(AuthStore);
  private readonly destroyRef = inject(DestroyRef);

  // --- Query state --------------------------------------------------------------------------
  /** Whether the table has said which scope it shows (a farm or the whole fleet): no request before. */
  private readonly scoped = signal(false);
  readonly farmId = signal<string | null>(null);
  /** The text field's value (immediate); the query uses `appliedText`. */
  readonly queryText = signal('');
  private readonly appliedText = signal('');
  readonly status = signal<StatusFilter>('all');
  readonly commissionedFilter = signal<CommissionedFilter>('all');
  /** The "Hide turbines with no data" switch's own setting (it yields to the "No data" status). */
  readonly hideNoData = signal(true);
  readonly hidesNoData = computed(() => this.hideNoData() && this.status() !== 'no_data');
  readonly sort = signal<TurbineSort>({ key: 'time', dir: 'desc' });
  /** Power, wind and gearbox sorts need a single farm: the API refuses them fleet-wide. */
  readonly canSortByMetric = computed(() => this.farmId() !== null);
  private readonly cursor = signal<string | null>(null);
  /** 1-based number of the page shown (counted as the user moves; there are no jumps). */
  private readonly pageNumber = signal(1);

  private readonly query = computed<TurbineQuery | null>(() => {
    if (!this.scoped()) return null;
    const { key, dir } = this.sort();
    const commissioned = this.commissionedFilter();
    const status = this.status();
    return {
      ...(this.farmId() ? { farmId: this.farmId()! } : {}),
      ...(this.appliedText().trim() ? { q: this.appliedText().trim() } : {}),
      ...(status !== 'all' ? { status } : {}),
      ...(commissioned !== 'all' ? { commissioned: commissioned === 'yes' } : {}),
      ...(this.hidesNoData() ? { hasData: true } : {}),
      sort: key,
      dir,
      limit: TURBINE_PAGE_SIZE,
      ...(this.cursor() ? { cursor: this.cursor() } : {}),
    };
  });

  // --- The page -----------------------------------------------------------------------------
  private readonly items = signal<TurbineItem[]>([]);
  private readonly nextCursor = signal<string | null>(null);
  private readonly prevCursor = signal<string | null>(null);
  private readonly total = signal(0);
  private readonly totalCapped = signal(false);
  /** A page has arrived at least once. */
  readonly loaded = signal(false);
  private requestsSent = 0;
  private readonly load = latestLoad(
    (query: TurbineQuery) => this.api.turbines(query),
    (page) => this.applyPage(page),
  );
  /** The request in flight is a quiet minute-tick refetch: no loading state, no error. */
  private readonly quiet = signal(false);
  readonly loading = computed(() => this.load.loading() && !this.quiet());
  readonly failed = computed(() => this.load.failed() && !this.quiet());

  /** The commissioned value being saved, per turbine; shown over whatever the page says. */
  private readonly commissionedSaving = signal<ReadonlyMap<string, boolean>>(new Map());
  readonly commissionedPending = computed<ReadonlySet<string>>(
    () => new Set(this.commissionedSaving().keys()),
  );
  /** Why the last commissioned change failed; cleared by the next change. */
  readonly commissionedError = signal<string | null>(null);

  /** The page's rows, in the server's order (see the class doc for live re-ordering). */
  readonly rows = computed<TurbineRow[]>(() => {
    const now = this.fleet.now();
    const saving = this.commissionedSaving();
    return this.items().map((t) => ({
      ...t,
      commissioned: saving.get(t.id) ?? t.commissioned,
      staleness: stalenessOf(t.latest, now),
    }));
  });

  /** The total in words ("1,234", "10,000+"), or null before the first page. */
  readonly totalLabel = computed(() => {
    if (!this.loaded()) return null;
    const format = new Intl.NumberFormat('en-US');
    return this.totalCapped()
      ? `${format.format(TOTAL_DISPLAY_CAP)}+`
      : format.format(this.total());
  });
  readonly hasNext = computed(() => this.nextCursor() !== null);
  readonly hasPrevious = computed(() => this.prevCursor() !== null);
  /** For `<mat-paginator [appCursorPaging]="store.paging">`. */
  readonly paging = cursorPaging({
    pageIndex: computed(() => this.pageNumber() - 1),
    pageSize: signal(TURBINE_PAGE_SIZE),
    count: computed(() => this.items().length),
    totalLabel: this.totalLabel,
    hasNext: this.hasNext,
    hasPrevious: this.hasPrevious,
    next: () => this.next(),
    previous: () => this.previous(),
  });

  // --- Live ---------------------------------------------------------------------------------
  /** The turbines a live batch updated in the last `FLASH_MS` (one timer each, so a burst finishes). */
  readonly recentlyUpdated = signal<ReadonlySet<string>>(new Set());
  private readonly flashTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The newest unapplied reading per turbine on the page. */
  private readonly pending = new Map<string, Telemetry>();
  private batchTimer?: ReturnType<typeof setTimeout>;
  private watchTimer?: ReturnType<typeof setTimeout>;
  private filterTimer?: ReturnType<typeof setTimeout>;
  /**
   * Set by the table: runs the change that re-orders the rows (`RowGlide.reorder`), so they glide.
   * Without it the batch just applies the change.
   */
  reorderWith: ((change: () => void) => void) | null = null;
  /** The clock's minute: changes once a minute, not on every reading that sets `fleet.now()`. */
  private readonly minute = computed(() => Math.floor(this.fleet.now() / MINUTE_MS));
  private readonly visibleIds = computed(() => this.items().map((t) => t.id), { equal: sameIds });

  constructor() {
    effect(() => {
      const query = this.query();
      if (query) untracked(() => this.send(query));
    });
    effect(() => {
      const ids = this.visibleIds();
      untracked(() => {
        clearTimeout(this.watchTimer);
        this.watchTimer = setTimeout(() => this.fleet.watchTurbines(this, ids), WATCH_DEBOUNCE_MS);
      });
    });
    // `fleet.changed` may have moved turbines.
    // Also after every open: readings between the connect and the subscription are not replayed.
    let seen = `${this.fleet.streamOpens()}:${this.fleet.fleetVersion()}`;
    effect(() => {
      const now = `${this.fleet.streamOpens()}:${this.fleet.fleetVersion()}`;
      if (now === seen) return;
      seen = now;
      // A first page still on its way will be newer than the open anyway.
      untracked(() => (this.loaded() || !this.loading() ? this.refetch() : undefined));
    });
    // With a status filter the server judges "reporting" at `asOf`: ask again each minute so a row
    // whose pill aged past 15 minutes leaves the filter. `asOf` is not part of `query`, so it never
    // resets the page or triggers the effect above; this is its only trigger.
    let lastMinute = this.minute();
    effect(() => {
      const minute = this.minute();
      if (minute === lastMinute) return;
      lastMinute = minute;
      untracked(() => {
        if (this.status() === 'all' || !this.scoped()) return;
        if (this.loaded() || !this.loading()) this.refetch(true);
      });
    });
    this.fleet.readings$
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe((r) => this.receive(r));
    this.destroyRef.onDestroy(() => {
      clearTimeout(this.batchTimer);
      clearTimeout(this.watchTimer);
      clearTimeout(this.filterTimer);
      this.flashTimers.forEach((timer) => clearTimeout(timer));
      this.fleet.watchTurbines(this, []);
    });
  }

  // --- Query changes ------------------------------------------------------------------------
  /** The scope: one farm's turbines, or null for the whole fleet. Sends the first request. */
  setScope(farmId: string | null): void {
    if (this.scoped() && this.farmId() === farmId) return;
    this.farmId.set(farmId);
    this.scoped.set(true);
    if (!farmId && METRIC_SORT_KEYS.includes(this.sort().key)) {
      this.sort.set({ key: 'time', dir: 'desc' });
    }
    this.firstPage();
  }

  /** The text filter (turbine id, farm id or farm name): applied `FILTER_DEBOUNCE_MS` after typing. */
  setQuery(text: string): void {
    this.queryText.set(text);
    clearTimeout(this.filterTimer);
    this.filterTimer = setTimeout(() => this.applyText(text), FILTER_DEBOUNCE_MS);
  }

  /** Empties the text filter at once. */
  clearQuery(): void {
    clearTimeout(this.filterTimer);
    this.queryText.set('');
    this.applyText('');
  }

  setStatus(status: StatusFilter): void {
    this.status.set(status);
    this.firstPage();
  }

  setCommissionedFilter(filter: CommissionedFilter): void {
    this.commissionedFilter.set(filter);
    this.firstPage();
  }

  setHideNoData(hide: boolean): void {
    this.hideNoData.set(hide);
    this.firstPage();
  }

  /** A metric sort without a farm is ignored (the API answers 400). */
  setSort(sort: TurbineSort): void {
    if (METRIC_SORT_KEYS.includes(sort.key) && !this.canSortByMetric()) return;
    this.sort.set(sort);
    this.firstPage();
  }

  next(): void {
    const cursor = this.nextCursor();
    if (cursor === null) return;
    this.cursor.set(cursor);
    this.pageNumber.update((n) => n + 1);
  }

  previous(): void {
    if (this.pageNumber() <= 1) return;
    this.cursor.set(this.prevCursor());
    this.pageNumber.update((n) => (this.prevCursor() === null ? 1 : n - 1));
  }

  /** Loads the current page again (after a failure). */
  retry(): void {
    this.refetch();
  }

  private applyText(text: string): void {
    if (this.appliedText() === text) return;
    this.appliedText.set(text);
    this.firstPage();
  }

  private firstPage(): void {
    this.cursor.set(null);
    this.pageNumber.set(1);
  }

  private send(query: TurbineQuery, quiet = false): void {
    this.requestsSent++;
    this.quiet.set(quiet);
    // The server's clock must match the pill's: send ours, only with a status filter.
    this.load.run(
      query.status ? { ...query, asOf: new Date(this.fleet.now()).toISOString() } : query,
    );
  }

  /** Quietly loads the current query (same cursor) again; the rows stay until the answer. */
  private refetch(quiet = false): void {
    const query = this.query();
    if (query) this.send(query, quiet);
  }

  private applyPage(page: TurbinePageResponse): void {
    this.items.set(page.items);
    this.nextCursor.set(page.nextCursor);
    this.prevCursor.set(page.prevCursor);
    this.total.set(page.total);
    this.totalCapped.set(page.totalCapped);
    this.loaded.set(true);
  }

  // --- Live readings ------------------------------------------------------------------------
  private receive(reading: Telemetry): void {
    if (!this.visibleIds().includes(reading.turbineId)) return;
    const queued = this.pending.get(reading.turbineId);
    if (queued && queued.timestamp >= reading.timestamp) return;
    this.pending.set(reading.turbineId, reading);
    this.batchTimer ??= setTimeout(() => this.flush(), LIVE_BATCH_MS);
  }

  /** One update for the whole batch: newer-than-latest readings only, then flash and (maybe) order. */
  private flush(): void {
    this.batchTimer = undefined;
    const batch = new Map(this.pending);
    this.pending.clear();
    const updated: string[] = [];
    const next = this.items().map((t) => {
      const reading = batch.get(t.id);
      if (!reading || (t.latest && t.latest.timestamp >= reading.timestamp)) return t;
      updated.push(t.id);
      return { ...t, latest: reading };
    });
    if (!updated.length) return;
    const { key, dir } = this.sort();
    const ordered = LIVE_SORT_KEYS.includes(key)
      ? [...next].sort(
          (a, b) =>
            compare(SORT_VALUE[key as keyof typeof SORT_VALUE], a, b, dir) ||
            a.id.localeCompare(b.id),
        )
      : next;
    const moves =
      ordered.some((t, i) => t.id !== next[i].id) ||
      ordered.some((t, i) => t.id !== this.items()[i]?.id);
    const apply = () => this.items.set(ordered);
    if (moves && this.reorderWith) this.reorderWith(apply);
    else apply();
    updated.forEach((id) => this.markUpdated(id));
  }

  private markUpdated(turbineId: string): void {
    clearTimeout(this.flashTimers.get(turbineId));
    this.flashTimers.set(
      turbineId,
      setTimeout(() => {
        this.flashTimers.delete(turbineId);
        this.recentlyUpdated.update((ids) => {
          const rest = new Set(ids);
          rest.delete(turbineId);
          return rest;
        });
      }, FLASH_MS),
    );
    if (!this.recentlyUpdated().has(turbineId)) {
      this.recentlyUpdated.update((ids) => new Set(ids).add(turbineId));
    }
  }

  // --- Commissioned -------------------------------------------------------------------------
  /**
   * Marks a turbine commissioned or not: shown at once, then PATCHed (one request per turbine at a
   * time; a call while one is pending is ignored). A failure goes back to what the server last said,
   * sets `commissionedError` and loads the page again. This is not a reading: no flash, no re-order.
   *
   * On success, a page request that overlapped can't be trusted for this turbine (it may have read
   * the row before the commit), so it is replaced by a new one; so is the page when a filter or the
   * sort looks at the value (the row may leave it).
   */
  setCommissioned(turbineId: string, commissioned: boolean): void {
    if (this.commissionedSaving().has(turbineId)) return;
    this.commissionedError.set(null);
    this.commissionedSaving.update((saving) => new Map(saving).set(turbineId, commissioned));
    const sentBefore = this.requestsSent;
    this.api
      .setCommissioned(turbineId, commissioned)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (updated) => {
          this.items.update((items) =>
            items.map((t) =>
              t.id === turbineId ? { ...t, commissioned: updated.commissioned } : t,
            ),
          );
          this.endCommissionedSave(turbineId);
          const looksAtIt =
            this.commissionedFilter() !== 'all' || this.sort().key === 'commissioned';
          if (looksAtIt || this.requestsSent !== sentBefore || this.loading()) this.refetch();
        },
        error: (error: unknown) => {
          this.endCommissionedSave(turbineId);
          this.commissionedError.set(commissionedErrorMessage(error, turbineId, commissioned));
          // The change may have committed (a lost answer). A 401 just signed out: nothing to load.
          if (this.auth.isAuthenticated()) this.refetch();
        },
      });
  }

  private endCommissionedSave(turbineId: string): void {
    this.commissionedSaving.update((saving) => {
      const rest = new Map(saving);
      rest.delete(turbineId);
      return rest;
    });
  }
}

/** Ascending or descending; turbines without a value (no readings) always go last. */
function compare(
  value: (t: TurbineItem) => string | number | null,
  a: TurbineItem,
  b: TurbineItem,
  dir: 'asc' | 'desc',
): number {
  const [x, y] = [value(a), value(b)];
  if (x === y) return 0;
  if (x === null) return 1;
  if (y === null) return -1;
  const order = typeof x === 'number' ? x - (y as number) : x.localeCompare(y as string);
  return dir === 'asc' ? order : -order;
}
