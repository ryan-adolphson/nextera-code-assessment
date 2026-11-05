import { DOCUMENT } from '@angular/common';
import {
  Component,
  ElementRef,
  afterRenderEffect,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
  viewChild,
  viewChildren,
} from '@angular/core';
import { MatButton } from '@angular/material/button';
import { MatButtonToggle, MatButtonToggleGroup } from '@angular/material/button-toggle';
import { Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { map, of, tap } from 'rxjs';
// ChartGroup is @defer-red: the compiler drops its import (and ECharts) from this route's chunk.
import { ChartGroup } from '../charts/chart-group';
import type { ChartSeries } from '../charts/chart-group';
import { ChartSkeleton, ChartSkeletonCard } from '../charts/chart-skeleton';
import type { TimeRange } from '../charts/line-chart';
import { AppTimePipe } from '../core/app-time.pipe';
import { TimeZoneSettings } from '../core/time-zone';
import { FarmHeader } from '../fleet/farm-header';
import { FleetStore } from '../fleet/fleet.store';
import { METRICS } from '../fleet/metrics';
import { latestLoad } from '../ui/latest-load';
import { FarmHistoryApi } from './farm-history-api.service';
import { FarmHistoryCache, FarmHistoryKey } from './farm-history-cache';
import { FarmDailyHistory } from './farm-history.model';
import { FARM_HISTORY_RANGES, FarmHistoryRange, lastDays, powerCandles } from './farm-history';

/** A load: the cached answer when fresh, unless `bypass` (Retry, Refresh, a rollup reload). */
interface HistoryLoad extends FarmHistoryKey {
  bypass?: boolean;
}

const sameKey = (a: FarmHistoryKey | null, b: FarmHistoryKey | null) =>
  JSON.stringify(a) === JSON.stringify(b);

const POWER = METRICS.find((m) => m.key === 'powerOutputKw')!;

/**
 * /farms/:farmId/history (the farm's History tab): the farm's power output (the sum over its
 * turbines) as one candle per day, precomputed by the farm rollup job every 15 minutes. Ranges
 * 30d / 90d / 6 months of whole days ending today in the zone shown (Settings). One request per
 * farm, range or zone (none on live readings); answers are reused from `FarmHistoryCache` until
 * the next `farm-rollup.completed` event (`FleetStore.farmRollupVersion`), or 15 minutes as the
 * fallback, so switching ranges or tabs back sends nothing. Retry and Refresh skip the cache. When
 * the version changes, the shown days reload quietly (skipping the cache): the chart stays,
 * undimmed, and a failure of that reload shows no error.
 */
@Component({
  selector: 'app-farm-history-page',
  imports: [
    AppTimePipe,
    ChartGroup,
    ChartSkeleton,
    FarmHeader,
    MatButton,
    MatButtonToggle,
    MatButtonToggleGroup,
    RouterLink,
  ],
  templateUrl: './farm-history-page.html',
})
export class FarmHistoryPage {
  /** Bound from the route parameter (withComponentInputBinding). */
  readonly farmId = input.required<string>();

  private readonly api = inject(FarmHistoryApi);
  private readonly cache = inject(FarmHistoryCache);
  protected readonly store = inject(FleetStore);
  private readonly title = inject(Title);
  protected readonly tz = inject(TimeZoneSettings);
  private readonly document = inject(DOCUMENT);

  private readonly refreshButton = viewChild('refresh', { read: ElementRef<HTMLElement> });
  private readonly retryButton = viewChild('retry', { read: ElementRef<HTMLElement> });
  private readonly rangeToggles = viewChildren(MatButtonToggle);
  /** Retry or Refresh was pressed and its load hasn't ended: focus may need a new home. */
  private restoreFocus = false;

  protected readonly ranges = FARM_HISTORY_RANGES;
  protected readonly range = signal<FarmHistoryRange>('30d');

  protected readonly farm = computed(
    () => this.store.farms().find((f) => f.id === this.farmId()) ?? null,
  );

  /** What to show: the range's days ending today (the store's minute clock), or null (unknown farm). */
  private readonly key = computed(
    (): FarmHistoryKey | null => {
      const farm = this.farm();
      if (!farm) return null;
      const zone = this.tz.zone();
      const days = this.ranges.find((r) => r.id === this.range())!.days;
      return {
        farmId: farm.id,
        range: this.range(),
        zone,
        ...lastDays(this.store.now(), days, zone),
      };
    },
    { equal: sameKey },
  );

  private readonly load = latestLoad(({ bypass, ...key }: HistoryLoad) => {
    // The version when the request starts: an answer that began before a rollup is stored under
    // the old version, so it never counts as fresh afterwards.
    const version = untracked(this.store.farmRollupVersion);
    const cached = bypass ? null : this.cache.get(key, version);
    const answer$ = cached
      ? of(cached)
      : this.api
          .daily(key.farmId, { from: key.from, to: key.to, timeZone: key.zone })
          .pipe(tap((history) => this.cache.set(key, history, version)));
    return answer$.pipe(map((history: FarmDailyHistory) => ({ key, history })));
  });
  /** The request in flight is a quiet rollup reload: no loading state, no error. */
  private readonly quiet = signal(false);
  protected readonly loading = computed(() => this.load.loading() && !this.quiet());
  protected readonly failed = computed(() => this.load.failed() && !this.quiet());
  /** The latest answer for this farm (an earlier range's stays, dimmed, until the next arrives). */
  protected readonly shown = computed(() => {
    const value = this.load.value();
    return value && value.key.farmId === this.farmId() ? value : null;
  });
  protected readonly history = computed(() => this.shown()?.history ?? null);
  protected readonly empty = computed(
    () => !this.failed() && !this.loading() && this.history()?.days.length === 0,
  );
  /** What the chart draws (null: nothing to draw): daily power candles over the loaded days. */
  protected readonly chart = computed(() => {
    const shown = this.shown();
    if (!shown || this.failed() || !shown.history.days.length) return null;
    const { history, key } = shown;
    const series: ChartSeries = {
      key: POWER.key,
      title: 'Farm power output',
      unit: POWER.unit,
      decimals: POWER.decimals,
      points: [],
      candles: powerCandles(history.days, history.turbineCount, key.zone),
      candleLabel: 'Daily',
    };
    const domain: TimeRange = { from: Date.parse(key.from), to: Date.parse(key.to) };
    return { charts: [series], domain, key };
  });
  /** Zoom resets for another farm, range, zone or days, not when the same days reload. */
  protected readonly resetKey = computed(() => JSON.stringify(this.chart()?.key ?? null));
  protected readonly hasCharts = computed(() => this.chart() !== null);
  protected readonly chartSkeleton: ChartSkeletonCard[] = [
    { title: 'Farm power output', lines: 1 },
  ];

  constructor() {
    // A new farm, range, zone or day: one load (cached answers count). The same key again sends nothing.
    let loaded: FarmHistoryKey | null = null;
    effect(() => {
      const key = this.key();
      if (!key || sameKey(key, loaded)) return;
      loaded = key;
      untracked(() => this.send(key));
    });
    // A farm rollup committed: reload the shown days quietly (chart stays, no error on failure).
    // The first run (page open) is skipped: the key effect already loads.
    let firstVersion = true;
    effect(() => {
      this.store.farmRollupVersion();
      if (firstVersion) {
        firstVersion = false;
        return;
      }
      untracked(() => {
        const key = this.key();
        if (key) this.send({ ...key, bypass: true }, true);
      });
    });
    // "<Farm> · History · Nextera" once the farm's name is known (the route names it by id).
    effect(() => {
      const farm = this.farm();
      if (farm) untracked(() => this.title.setTitle(`${farm.name} · History · Nextera`));
    });
    // Retry leaves with the error, and Refresh with the chart when its load fails: if the button
    // that was pressed is gone (focus fell to <body>), focus the control that took its place —
    // Retry after a failure, else Refresh, else the selected range.
    afterRenderEffect(() => {
      const failed = this.failed();
      const loading = this.loading();
      const target = failed
        ? this.retryButton()?.nativeElement
        : (this.refreshButton()?.nativeElement ?? this.rangeToggles().find((t) => t.checked));
      if (!this.restoreFocus) return;
      const active = this.document.activeElement;
      if (!active || active === this.document.body) target?.focus();
      if (!loading) this.restoreFocus = false;
    });
  }

  protected setRange(range: FarmHistoryRange): void {
    this.range.set(range);
  }

  /** Retry (after a failure) and Refresh: load the days shown again, skipping the cache. */
  protected reload(): void {
    // Refresh stays clickable while disabled (disabledInteractive): ignore it while loading.
    if (this.loading()) return;
    this.restoreFocus = true;
    // The buttons are only shown for a known farm, so there is a key.
    this.send({ ...this.key()!, bypass: true });
  }

  /**
   * Starts a load. A quiet one is demoted to a normal one while a user-started load is in flight
   * (it replaces that request, which must keep its loading state); any user-started load clears
   * the quiet flag, so `loading`/`failed` are right whichever came last.
   */
  private send(request: HistoryLoad, quiet = false): void {
    this.quiet.set(quiet && !(this.load.loading() && !this.quiet()));
    this.load.run(request);
  }
}
