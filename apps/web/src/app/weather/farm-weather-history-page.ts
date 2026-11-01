import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { MatButton } from '@angular/material/button';
import { provideNativeDateAdapter } from '@angular/material/core';
import {
  MatDateRangeInput,
  MatDateRangePicker,
  MatDatepickerToggle,
  MatEndDate,
  MatStartDate,
} from '@angular/material/datepicker';
import { MatFormField, MatLabel, MatSuffix } from '@angular/material/form-field';
import { Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { map } from 'rxjs';
// ChartGroup is @defer-red: the compiler drops its import (and ECharts) from this route's chunk.
import { ChartGroup } from '../charts/chart-group';
import { ChartSkeleton, ChartSkeletonCard } from '../charts/chart-skeleton';
import { TimeRange } from '../charts/line-chart';
import { NOW } from '../core/clock';
import { dayOf, dayRange, pickerDate, rangeError } from '../core/days';
import { TimeZoneSettings } from '../core/time-zone';
import { FarmHeader } from '../fleet/farm-header';
import { FleetStore } from '../fleet/fleet.store';
import { latestLoad } from '../ui/latest-load';
import { WeatherApi } from './weather-api.service';
import {
  WEATHER_HISTORY_CHARTS,
  WEATHER_STEP_MS,
  weatherDays,
  weatherHistoryCharts,
} from './weather';

interface HistoryRequest {
  farmId: string;
  from: string;
  to: string;
}

const sameRequest = (a: HistoryRequest | null, b: HistoryRequest | null) =>
  JSON.stringify(a) === JSON.stringify(b);

/**
 * /farms/:farmId/weather (the farm's Weather history tab): the farm's Open-Meteo weather in
 * 30-minute buckets over whole days chosen with a Material date range picker (default the last 7
 * days ending today, at most 31), one line chart per metric on a shared time axis (crosshair,
 * zoom). Days are in the zone shown (Settings); a zone change keeps the picked calendar dates and
 * queries them in the new zone. One request per range (GET …/weather?interval=30min); an
 * incomplete or invalid range says why and sends none. Missing buckets are gaps in the lines.
 */
@Component({
  selector: 'app-farm-weather-history-page',
  imports: [
    ChartGroup,
    ChartSkeleton,
    FarmHeader,
    MatButton,
    MatDateRangeInput,
    MatDateRangePicker,
    MatDatepickerToggle,
    MatEndDate,
    MatFormField,
    MatLabel,
    MatStartDate,
    MatSuffix,
    RouterLink,
  ],
  templateUrl: './farm-weather-history-page.html',
  // Native Dates (browser-local midnights; their calendar dates name days in the zone shown).
  providers: [provideNativeDateAdapter()],
})
export class FarmWeatherHistoryPage {
  /** Bound from the route parameter (withComponentInputBinding). */
  readonly farmId = input.required<string>();

  private readonly api = inject(WeatherApi);
  private readonly store = inject(FleetStore);
  private readonly title = inject(Title);
  private readonly now = inject(NOW);
  protected readonly tz = inject(TimeZoneSettings);

  protected readonly farm = computed(
    () => this.store.farms().find((f) => f.id === this.farmId()) ?? null,
  );

  /** The picked days (the picker's Dates; null while not chosen or not a valid date). */
  protected readonly start = signal<Date | null>(null);
  protected readonly end = signal<Date | null>(null);
  /** No future days: the last selectable day is today (in the zone shown). */
  protected readonly maxDate = computed(() =>
    pickerDate(weatherDays(this.now(), this.tz.zone()).end, this.tz.zone()),
  );
  private readonly startDay = computed(() => dayOf(this.start(), this.tz.zone()));
  private readonly endDay = computed(() => dayOf(this.end(), this.tz.zone()));
  protected readonly error = computed(() =>
    rangeError(this.startDay(), this.endDay(), this.tz.zone()),
  );

  /** The range to show (null: unknown farm or an invalid range, so no request). */
  private readonly request = computed(
    (): HistoryRequest | null => {
      const farm = this.farm();
      const [start, end] = [this.startDay(), this.endDay()];
      if (!farm || this.error() || start === null || end === null) return null;
      return { farmId: farm.id, ...dayRange(start, end, this.tz.zone()) };
    },
    { equal: sameRequest },
  );

  private readonly load = latestLoad((request: HistoryRequest) =>
    this.api
      .farm(request.farmId, { from: request.from, to: request.to, interval: '30min' })
      .pipe(map((res) => ({ request, slots: res.points }))),
  );
  protected readonly loading = this.load.loading;
  protected readonly failed = this.load.failed;
  /** The latest answer for this farm (an earlier range's stays, dimmed, until the next arrives). */
  protected readonly shown = computed(() => {
    const value = this.load.value();
    return value && value.request.farmId === this.farmId() ? value : null;
  });
  protected readonly charts = computed(() => weatherHistoryCharts(this.shown()?.slots ?? []));
  protected readonly hasData = computed(() => this.charts().some((c) => c.points.length > 0));
  protected readonly hasCharts = computed(() => !this.failed() && this.hasData());
  protected readonly empty = computed(
    () => !this.failed() && !this.loading() && this.shown() !== null && !this.hasData(),
  );
  /** The charts' time axis: the loaded days [from, to). */
  protected readonly domain = computed((): TimeRange | null => {
    const shown = this.shown();
    return shown
      ? { from: Date.parse(shown.request.from), to: Date.parse(shown.request.to) }
      : null;
  });
  /** Half-hours with any value, of those in the loaded days. */
  protected readonly synced = computed(() => {
    const shown = this.shown();
    const domain = this.domain();
    if (!shown || !domain || this.failed()) return null;
    const metrics = WEATHER_HISTORY_CHARTS.map((c) => c.metric);
    return {
      count: shown.slots.filter((slot) => metrics.some((m) => slot[m] !== null)).length,
      total: Math.round((domain.to - domain.from) / WEATHER_STEP_MS),
    };
  });
  /** Consecutive buckets are connected; a missing one breaks the line. */
  protected readonly gapMs = WEATHER_STEP_MS * 1.5;
  protected readonly chartSkeleton: ChartSkeletonCard[] = WEATHER_HISTORY_CHARTS.map((c) => ({
    title: c.title,
    lines: 0,
  }));

  constructor() {
    const zone = this.tz.zone();
    const { start, end } = weatherDays(this.now(), zone);
    this.start.set(pickerDate(start, zone));
    this.end.set(pickerDate(end, zone));
    // A new farm, range or zone (the same calendar dates, in the new zone): one request.
    effect(() => {
      const request = this.request();
      if (request) untracked(() => this.load.run(request));
    });
    // "<Farm> · Weather history · Nextera" once the farm's name is known (the route's title
    // names the farm by id until then).
    effect(() => {
      const farm = this.farm();
      if (farm) untracked(() => this.title.setTitle(`${farm.name} · Weather history · Nextera`));
    });
  }

  /** The picker changed a day (calendar or typed); a complete, valid range loads. */
  protected onStart(date: Date | null): void {
    this.start.set(date);
  }

  protected onEnd(date: Date | null): void {
    this.end.set(date);
  }

  protected retry(): void {
    this.load.retry();
  }
}
