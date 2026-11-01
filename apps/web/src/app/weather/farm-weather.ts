import { Component, computed, effect, inject, input, untracked } from '@angular/core';
import { MatButton } from '@angular/material/button';
import { format, hoursToMilliseconds } from 'date-fns';
import { map } from 'rxjs';
import { AppTimePipe } from '../core/app-time.pipe';
import { isoDay } from '../core/days';
import { TimeZoneSettings } from '../core/time-zone';
import { FleetStore } from '../fleet/fleet.store';
import { latestLoad } from '../ui/latest-load';
import { StatTile } from '../ui/stat-tile';
import { TABLE_IMPORTS } from '../ui/table';
import { WeatherApi } from './weather-api.service';
import { WeatherDay } from './weather.model';
import { WEATHER_DAYS, expectedSamples, latestSlot, recentDays, slotRange } from './weather';

/** How far back the latest 30-minute bucket is looked for (the sync may lag behind the clock). */
const RECENT_MS = hoursToMilliseconds(24);

interface DailyRequest {
  farmId: string;
  timeZone: string;
  from: string;
  to: string;
}

interface RecentRequest {
  farmId: string;
  from: string;
  to: string;
}

const sameRequest = <T extends object>(a: T, b: T) => JSON.stringify(a) === JSON.stringify(b);

/**
 * The farm page's Weather section (Open-Meteo, stored per farm): tiles for the newest 30-minute
 * bucket and today's temperature range, and a table of the last 7 days (daily: mean/max 80 m
 * wind, temperature min/max, precipitation). Days are calendar days in the zone shown (Settings),
 * so a zone change reloads them. Two requests: the last 24 h of buckets and the 7 days; each is
 * sent again only when its range moves (a new bucket or day) or the zone changes, never on live
 * readings.
 */
@Component({
  selector: 'app-farm-weather',
  imports: [AppTimePipe, MatButton, StatTile, TABLE_IMPORTS],
  templateUrl: './farm-weather.html',
})
export class FarmWeather {
  readonly farmId = input.required<string>();

  private readonly api = inject(WeatherApi);
  private readonly store = inject(FleetStore);
  protected readonly tz = inject(TimeZoneSettings);
  protected readonly days = WEATHER_DAYS;

  private readonly dailyLoad = latestLoad((request: DailyRequest) =>
    this.api
      .farm(request.farmId, {
        from: request.from,
        to: request.to,
        interval: 'daily',
        timeZone: request.timeZone,
      })
      .pipe(map((res) => ({ request, days: res.points }))),
  );
  private readonly recentLoad = latestLoad((request: RecentRequest) =>
    this.api
      .farm(request.farmId, { from: request.from, to: request.to, interval: '30min' })
      .pipe(map((res) => ({ request, slots: res.points }))),
  );

  /** The last 7 days ending today, in the zone shown (equal until the day or zone changes). */
  private readonly dailyRequest = computed(
    (): DailyRequest => {
      const zone = this.tz.zone();
      return { farmId: this.farmId(), timeZone: zone, ...recentDays(this.store.now(), zone) };
    },
    { equal: sameRequest },
  );
  /** The last 24 h in 30-minute buckets (equal until the clock enters a new bucket). */
  private readonly recentRequest = computed(
    (): RecentRequest => {
      const now = this.store.now();
      return { farmId: this.farmId(), ...slotRange(now - RECENT_MS, now) };
    },
    { equal: sameRequest },
  );

  /** The daily rows of this farm and zone (null while loading them or after a failure). */
  protected readonly daily = computed((): WeatherDay[] | null => {
    const value = this.dailyLoad.value();
    return value && !this.dailyLoad.failed() && sameRequest(value.request, this.dailyRequest())
      ? value.days
      : null;
  });
  /** The newest 30-minute bucket that has started (undefined while loading, null for none). */
  protected readonly latest = computed(() => {
    const value = this.recentLoad.value();
    if (!value || this.recentLoad.failed() || value.request.farmId !== this.farmId())
      return undefined;
    return latestSlot(value.slots, this.store.now());
  });
  protected readonly today = computed(
    () => this.daily()?.find((d) => d.date === isoDay(this.store.now(), this.tz.zone())) ?? null,
  );
  protected readonly failed = computed(() => this.dailyLoad.failed() || this.recentLoad.failed());
  protected readonly loading = computed(
    () => !this.failed() && (this.daily() === null || this.latest() === undefined),
  );
  protected readonly columns = [
    'date',
    'windMean',
    'windMax',
    'tempMin',
    'tempMax',
    'precip',
    'samples',
  ];
  protected readonly trackByDate = (_: number, d: WeatherDay) => d.date;

  constructor() {
    effect(() => {
      const request = this.dailyRequest();
      untracked(() => this.dailyLoad.run(request));
    });
    effect(() => {
      const request = this.recentRequest();
      untracked(() => this.recentLoad.run(request));
    });
  }

  /** "−1.2 / 4.5 °C": today's temperature range, or "–". */
  protected readonly todayRange = computed(() => {
    const today = this.today();
    return today?.temperature2mMinC == null || today.temperature2mMaxC == null
      ? '–'
      : `${this.value(today.temperature2mMinC)} / ${this.value(today.temperature2mMaxC, '°C')}`;
  });

  /** One decimal, with the unit; "–" for a missing value. */
  protected value(v: number | null, unit = ''): string {
    if (v === null) return '–';
    const text = v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    return unit ? `${text} ${unit}` : text;
  }

  protected retry(): void {
    if (this.dailyLoad.failed()) this.dailyLoad.retry();
    if (this.recentLoad.failed()) this.recentLoad.retry();
  }

  /** "Fri, Jan 2": a calendar day (YYYY-MM-DD, already in the zone shown; no instant to convert). */
  protected dayLabel(date: string): string {
    const [y, m, d] = date.split('-').map(Number);
    return format(new Date(y, m - 1, d), 'EEE, MMM d');
  }

  protected isToday(date: string): boolean {
    return date === isoDay(this.store.now(), this.tz.zone());
  }

  /** The buckets a complete day has (48; 46/50 on a DST day in the zone shown). */
  protected expected(date: string): number {
    return expectedSamples(date, this.tz.zone());
  }
}
