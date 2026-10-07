import { DatePipe, DecimalPipe } from '@angular/common';
import { Component, OnDestroy, computed, effect, inject, input, untracked } from '@angular/core';
import { MatButton } from '@angular/material/button';
import { differenceInMinutes } from 'date-fns';
import { millisecondsInHour } from 'date-fns/constants';
import { MatButtonToggle, MatButtonToggleGroup } from '@angular/material/button-toggle';
import { RouterLink } from '@angular/router';
import { AlertsCell } from '../alerting/alerts-cell';
import { alertSeries } from '../charts/alert-series';
import { ChartGroup, ChartSeries } from '../charts/chart-group';
import { ChartPoint } from '../charts/scales';
import { DELAYED_AFTER_MS, HISTORY_RANGES, READING_INTERVAL_MS, Telemetry } from './fleet.model';
import { paginate } from '../ui/paging';
import { TABLE_IMPORTS } from '../ui/table';
import { FleetStore } from './fleet.store';
import { METRICS, Metric } from './metrics';
import { StalenessBadge } from './staleness-badge';

/** /farms/:farmId/turbines/:turbineId: one turbine's status, charts per metric and readings. */
@Component({
  selector: 'app-turbine-page',
  imports: [
    AlertsCell,
    DatePipe,
    DecimalPipe,
    RouterLink,
    ChartGroup,
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

  /** One series per metric. */
  protected readonly charts = computed((): ChartSeries[] => {
    const ascending = this.ascending();
    const stats = this.store.stats()?.metrics;
    return METRICS.map((metric) => ({
      ...metric,
      points: ascending.map((r): ChartPoint => ({ t: Date.parse(r.timestamp), v: r[metric.key] })),
      stats: stats?.[metric.key] ?? null,
    }));
  });

  /**
   * The alerts chart: a line of how many rules each reading triggered (0, 1, 2…) with the flagged
   * readings as a scatter overlay, coloured by their worst level; the tooltip lists the rules.
   */
  protected readonly alertChart = computed(() => alertSeries(this.ascending()));
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
