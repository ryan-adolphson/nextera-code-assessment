import { DecimalPipe } from '@angular/common';
import { Component, OnDestroy, computed, effect, inject, input, untracked } from '@angular/core';
import { MatButton } from '@angular/material/button';
import { differenceInMinutes } from 'date-fns';
import { millisecondsInHour } from 'date-fns/constants';
import { MatButtonToggle, MatButtonToggleGroup } from '@angular/material/button-toggle';
import { RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { AlertsCell } from '../alerting/alerts-cell';
import { alertSeries } from '../charts/alert-series';
// Separate declarations: ChartGroup is @defer-red, and the compiler only defers a dependency whose
// whole import declaration it can drop.
import { ChartGroup } from '../charts/chart-group';
import type { ChartSeries } from '../charts/chart-group';
import { ChartSkeleton, ChartSkeletonCard } from '../charts/chart-skeleton';
import { ChartPoint } from '../charts/scales';
import { AppTimePipe } from '../core/app-time.pipe';
import { TimeZoneSettings } from '../core/time-zone';
import { DELAYED_AFTER_MS, HISTORY_RANGES, READING_INTERVAL_MS, Telemetry } from './fleet.model';
import { latestLoad } from '../ui/latest-load';
import { paginate } from '../ui/paging';
import { WeatherApi } from '../weather/weather-api.service';
import { WeatherSlot } from '../weather/weather.model';
import { WEATHER_STEP_MS, slotRange, weatherCharts, windOverlay } from '../weather/weather';
import { TABLE_IMPORTS } from '../ui/table';
import { FleetStore } from './fleet.store';
import { METRICS, Metric } from './metrics';
import { StalenessBadge } from './staleness-badge';

/** The turbine weather request: [from, to) covering the page's window, in 30-minute buckets. */
interface WeatherRequest {
  turbineId: string;
  from: string;
  to: string;
}

function sameWeatherRequest(a: WeatherRequest | null, b: WeatherRequest | null): boolean {
  return a?.turbineId === b?.turbineId && a?.from === b?.from && a?.to === b?.to;
}

/**
 * /farms/:farmId/turbines/:turbineId: one turbine's status, charts per metric and readings, plus
 * its farm's Open-Meteo weather for the same window (the 80 m wind over the wind chart, and
 * temperature, gusts and precipitation charts on the shared axis). A window without readings
 * shows only the empty-window message: no weather, and no weather request.
 */
@Component({
  selector: 'app-turbine-page',
  imports: [
    AlertsCell,
    AppTimePipe,
    DecimalPipe,
    RouterLink,
    ChartGroup,
    ChartSkeleton,
    MatButton,
    MatButtonToggle,
    MatButtonToggleGroup,
    StalenessBadge,
    TABLE_IMPORTS,
  ],
  templateUrl: './turbine-page.html',
})
export class TurbinePage implements OnDestroy {
  /** Bound from the route parameters (withComponentInputBinding). */
  readonly farmId = input.required<string>();
  readonly turbineId = input.required<string>();

  protected readonly store = inject(FleetStore);
  protected readonly tz = inject(TimeZoneSettings);
  protected readonly ranges = HISTORY_RANGES;
  protected readonly gapMs = READING_INTERVAL_MS * 1.5; // one missing reading breaks the line

  /** The readings table: newest first, 50 per page (Material paginator). */
  protected readonly readingColumns: { key: Metric; label: string }[] = [
    { key: 'powerOutputKw', label: 'Power (kW)' },
    { key: 'windSpeedMs', label: 'Wind (m/s)' },
    { key: 'rotorRpm', label: 'Rotor (rpm)' },
    { key: 'bladePitchDeg', label: 'Pitch (°)' },
    { key: 'gearboxTempC', label: 'Gearbox (°C)' },
  ];
  protected readonly historyColumns = [
    'measured',
    'delay',
    ...this.readingColumns.map((c) => c.key),
    'alerts',
  ];
  protected readonly historyPaging = paginate(this.store.history, 50, [25, 50, 100, 250]);
  protected readonly trackById = (_: number, r: Telemetry) => r.id;

  protected readonly turbine = computed(
    () =>
      this.store.turbines().find((t) => t.id === this.turbineId() && t.farmId === this.farmId()) ??
      null,
  );

  /** The readings in time order (the store keeps them newest first), for every chart. */
  private readonly ascending = computed(() => [...this.store.history()].reverse());

  /** One series per metric; the wind chart also shows the farm's modelled 80 m wind. */
  protected readonly charts = computed((): ChartSeries[] => {
    const ascending = this.ascending();
    const stats = this.store.stats()?.metrics;
    const slots = this.weatherState() === 'ok' ? this.weather() : null;
    return METRICS.map((metric) => ({
      ...metric,
      points: ascending.map((r): ChartPoint => ({ t: Date.parse(r.timestamp), v: r[metric.key] })),
      stats: stats?.[metric.key] ?? null,
      overlay: metric.key === 'windSpeedMs' && slots ? windOverlay(slots) : null,
    }));
  });

  private readonly weatherApi = inject(WeatherApi);
  /** The farm's 30-minute weather for the window (the latest request's answer). */
  private readonly weatherLoad = latestLoad((request: WeatherRequest) =>
    this.weatherApi
      .turbine(request.turbineId, { from: request.from, to: request.to, interval: '30min' })
      .pipe(map((res) => ({ turbineId: request.turbineId, slots: res.points }))),
  );
  /** Whether the turbine is in the fleet (not on every live reading, unlike `turbine`). */
  private readonly known = computed(() => this.turbine() !== null);
  /**
   * Weather is only shown alongside telemetry: requested once the window's readings have loaded
   * and there are some (never while the history loads, so a range or turbine change doesn't send
   * a request it would then cancel; never for an empty window).
   */
  private readonly hasReadings = computed(
    () => !this.store.historyLoading() && this.store.history().length > 0,
  );
  /**
   * The window in whole 30-minute buckets: equal while the clock ticks inside a bucket, so the
   * weather is fetched once per turbine and range, and again only when the window has slid into
   * a new bucket (never on live readings). Null while there is nothing to show it with.
   */
  private readonly weatherRequest = computed(
    (): WeatherRequest | null => {
      if (!this.known() || !this.hasReadings()) return null;
      const now = this.store.now();
      return { turbineId: this.turbineId(), ...slotRange(now - this.store.historyRangeMs(), now) };
    },
    { equal: sameWeatherRequest },
  );
  /** This turbine's weather (null while loading the first time or after a failed request). */
  protected readonly weather = computed((): WeatherSlot[] | null => {
    const value = this.weatherLoad.value();
    return value && !this.weatherLoad.failed() && value.turbineId === this.turbineId()
      ? value.slots
      : null;
  });
  /** The weather charts, shown under the telemetry charts when the window has weather. */
  protected readonly weatherCharts = computed(() =>
    this.weatherState() === 'ok' ? weatherCharts(this.weather()!) : [],
  );
  protected readonly weatherState = computed((): 'loading' | 'error' | 'empty' | 'ok' => {
    if (this.weatherLoad.failed()) return 'error';
    const slots = this.weather();
    const window = this.window();
    if (!slots || !window) return 'loading';
    const inWindow = slots.some((slot) => {
      const t = Date.parse(slot.time);
      return t + WEATHER_STEP_MS > window.from && t <= window.to;
    });
    return inWindow ? 'ok' : 'empty';
  });

  protected retryWeather(): void {
    this.weatherLoad.retry();
  }

  /**
   * The alerts chart: a line of how many rules each reading triggered (0, 1, 2…) with the flagged
   * readings as a scatter overlay, coloured by their worst level; the tooltip lists the rules.
   */
  protected readonly alertChart = computed(() => alertSeries(this.ascending()));
  /**
   * The charts' size before ECharts has loaded (`@defer` placeholder): a card per metric (candle
   * size and stats lines) and the alerts chart (its marker legend when readings were flagged).
   */
  protected readonly chartSkeleton = computed((): ChartSkeletonCard[] => [
    ...METRICS.map((metric) => ({ title: metric.title, lines: 2 })),
    { title: 'Alert rules triggered', lines: this.alertChart().markers.length ? 1 : 0 },
  ]);
  /** Another turbine or range: the chart group clears its crosshair and zoom. */
  protected readonly chartResetKey = computed(
    () => `${this.turbineId()}:${this.store.historyRangeMs()}`,
  );

  protected readonly window = computed(() => this.store.historyWindow());

  /** The selected range in words, e.g. "24 hours" (for the empty state). */
  protected readonly rangeName = computed(
    () =>
      this.ranges.find((r) => r.ms === this.store.historyRangeMs())?.long ??
      `${Math.round(this.store.historyRangeMs() / millisecondsInHour)} hours`,
  );

  /**
   * A longer preset that would include the turbine's last reading (offered in the empty state),
   * or null if none would (e.g. it last reported more than 7 days ago).
   */
  protected readonly longerRange = computed(() => {
    const latest = this.turbine()?.latest;
    if (!latest) return null;
    const age = this.store.now() - Date.parse(latest.timestamp);
    return this.ranges.find((r) => r.ms > this.store.historyRangeMs() && r.ms >= age) ?? null;
  });

  constructor() {
    // Load this turbine's readings; reloads if the route switches to another turbine.
    effect(() => {
      const id = this.turbineId();
      untracked(() => this.store.select(id));
    });
    // The weather for the window: once per turbine, range and 30-minute bucket, and only while
    // the window has readings. The same request after a pause (e.g. the window emptied, then a
    // live reading landed in the same bucket) is not sent again.
    let sent: WeatherRequest | null = null;
    effect(() => {
      const request = this.weatherRequest();
      if (!request || sameWeatherRequest(request, sent)) return;
      sent = request;
      untracked(() => this.weatherLoad.run(request));
    });
  }

  ngOnDestroy(): void {
    this.store.select(null);
  }

  protected setRange(ms: number): void {
    this.historyPaging.reset();
    this.store.select(this.turbineId(), ms);
  }

  protected delayMinutes(reading: Telemetry): number {
    return differenceInMinutes(reading.receivedAt, reading.timestamp, { roundingMethod: 'round' });
  }

  protected isDelayed(reading: Telemetry): boolean {
    return Date.parse(reading.receivedAt) - Date.parse(reading.timestamp) > DELAYED_AFTER_MS;
  }
}
