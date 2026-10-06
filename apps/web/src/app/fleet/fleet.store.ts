import { DestroyRef, Injectable, computed, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { Subject, Subscription, catchError, of, switchMap } from 'rxjs';
import { NOW } from '../core/clock';
import { SseService, SseStatus } from '../core/sse.service';
import { FleetApi, TelemetryWindow } from './fleet-api.service';
import {
  CLOCK_TICK_MS,
  DEFAULT_HISTORY_RANGE_MS,
  FarmOverview,
  MAX_HISTORY_READINGS,
  READING_INTERVAL_MS,
  TELEMETRY_EVENTS,
  Telemetry,
  TelemetryStats,
} from './fleet.model';
import { Staleness, freshestStaleness, stalenessOf } from './staleness';

export type LiveStatus = SseStatus | 'offline';

export interface FarmSummary {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  turbineCount: number;
  /** Turbines whose staleness is 'ok'; output and wind only count these. */
  reporting: number;
  /** The freshest turbine's level ('empty' without turbines or readings); see `farms`. */
  staleness: Staleness;
  powerKw: number;
  avgWindMs: number | null;
}

/**
 * Fleet state for the dashboard. Readings arrive late and out of order, so everything is keyed by
 * measurement time: the "latest" reading per turbine is the one with the newest `timestamp`, and a
 * late reading for an older instant never replaces it.
 */
@Injectable()
export class FleetStore {
  private readonly api = inject(FleetApi);
  private readonly sse = inject(SseService);
  private readonly destroyRef = inject(DestroyRef);
  private readonly clock = inject(NOW);

  private readonly farmList = signal<FarmOverview[]>([]);
  private readonly latestByTurbine = signal(new Map<string, Telemetry>());
  private historySub?: Subscription;
  /** The selected turbine's loaded and live readings, newest first (may extend past the window). */
  private readonly loadedHistory = signal<Telemetry[]>([]);
  /** Live readings received while the history request is pending (merged into its response). */
  private liveWhileLoading: Telemetry[] = [];
  private tickTimer?: ReturnType<typeof setTimeout>;

  /**
   * The client time (epoch ms): the reference for staleness and the end of the selected turbine's
   * window. Re-read on `init`, every `CLOCK_TICK_MS` (aligned to the minute) while the store
   * lives, on every select and on every live reading for the selected turbine.
   */
  readonly now = signal(this.clock());

  readonly liveStatus = signal<LiveStatus>('connecting');
  readonly loading = signal(true);
  readonly error = signal<string | null>(null);
  readonly recentlyUpdated = signal<string | null>(null);
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

  /** Newest measurement time across the fleet ("data as of"; staleness uses the client clock). */
  readonly fleetTime = computed(() => {
    let newest = 0;
    for (const r of this.latestByTurbine().values()) {
      newest = Math.max(newest, Date.parse(r.timestamp));
    }
    return newest || null;
  });

  /** Each turbine with its latest reading (by measurement time) and staleness at `now`. */
  readonly turbines = computed(() =>
    this.farmList().flatMap((farm) =>
      farm.turbines.map((t) => {
        const latest = this.latestByTurbine().get(t.id) ?? null;
        return {
          ...t,
          farmName: farm.name,
          latest,
          staleness: stalenessOf(latest, this.now()),
        };
      }),
    ),
  );

  /**
   * Per-farm totals over the reporting ('ok') turbines. A farm's `staleness` is its freshest
   * turbine's level: 'ok' if any turbine reports, else the least stale level among them (the
   * farm went quiet that long ago), and 'empty' if no turbine ever reported (or it has none).
   */
  readonly farms = computed<FarmSummary[]>(() =>
    this.farmList().map((farm) => {
      const levels = farm.turbines.map((t) =>
        stalenessOf(this.latestByTurbine().get(t.id), this.now()),
      );
      const readings = farm.turbines
        .filter((_, i) => levels[i] === 'ok')
        .map((t) => this.latestByTurbine().get(t.id)!);
      return {
        id: farm.id,
        name: farm.name,
        latitude: farm.latitude,
        longitude: farm.longitude,
        turbineCount: farm.turbines.length,
        reporting: readings.length,
        staleness: freshestStaleness(levels),
        powerKw: readings.reduce((sum, r) => sum + r.powerOutputKw, 0),
        avgWindMs: readings.length
          ? readings.reduce((sum, r) => sum + r.windSpeedMs, 0) / readings.length
          : null,
      };
    }),
  );

  readonly fleet = computed(() => {
    const farms = this.farms();
    return {
      farms: farms.length,
      turbines: farms.reduce((n, f) => n + f.turbineCount, 0),
      reporting: farms.reduce((n, f) => n + f.reporting, 0),
      powerKw: farms.reduce((n, f) => n + f.powerKw, 0),
    };
  });

  readonly selectedTurbine = computed(
    () => this.turbines().find((t) => t.id === this.selectedTurbineId()) ?? null,
  );

  /**
   * Subscribe to live readings first, then load: nothing that happens in between is missed.
   * Starts the minute clock, so staleness advances on every page without user interaction.
   */
  init(): void {
    this.now.set(this.clock());
    this.startTicking();
    this.sse
      .connect<Telemetry>(this.api.eventsUrl, TELEMETRY_EVENTS)
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (event) => {
          if (event.kind === 'status') this.liveStatus.set(event.status);
          else this.receive(event.data);
        },
        error: () => this.liveStatus.set('offline'),
      });

    this.api
      .farms()
      .pipe(takeUntilDestroyed(this.destroyRef))
      .subscribe({
        next: (farms) => {
          this.farmList.set(farms);
          for (const turbine of farms.flatMap((f) => f.turbines)) {
            if (turbine.latest) this.applyLatest(turbine.latest);
          }
          this.loading.set(false);
        },
        error: () => {
          this.error.set('Could not load the fleet.');
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
      return;
    }
    if (!sameTurbine) {
      this.loadedHistory.set([]);
      this.stats.set(null); // another turbine's stats must never show; same turbine: keep until new
    }

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

  private receive(reading: Telemetry): void {
    if (this.applyLatest(reading)) this.recentlyUpdated.set(reading.turbineId);
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
   * Re-reads the clock: updates every turbine's staleness and slides the selected turbine's
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

  /** Returns true if the reading became the turbine's latest. */
  private applyLatest(reading: Telemetry): boolean {
    const current = this.latestByTurbine().get(reading.turbineId);
    if (current && current.timestamp >= reading.timestamp) return false; // older or same instant
    this.latestByTurbine.update((map) => new Map(map).set(reading.turbineId, reading));
    return true;
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
