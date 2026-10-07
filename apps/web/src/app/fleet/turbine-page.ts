import { DatePipe, DecimalPipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  OnDestroy,
  computed,
  effect,
  inject,
  input,
  signal,
  untracked,
} from '@angular/core';
import { MatButton } from '@angular/material/button';
import { MatButtonToggle, MatButtonToggleGroup } from '@angular/material/button-toggle';
import { MatTooltip } from '@angular/material/tooltip';
import { RouterLink } from '@angular/router';
import { describeRuleWithLevel } from '../alerting/alert-config.model';
import { AlertLevelBadge } from '../alerting/alert-level-badge';
import { describeTriggerWithLevel } from '../alerting/alert-text';
import { ChartMarker, LineChart, TimeRange } from '../charts/line-chart';
import { ChartPoint } from '../charts/scales';
import { DELAYED_AFTER_MS, HISTORY_RANGES, READING_INTERVAL_MS, Telemetry } from './fleet.model';
import { paginate } from '../ui/paging';
import { TABLE_IMPORTS } from '../ui/table';
import { FleetStore } from './fleet.store';
import { StalenessBadge } from './staleness-badge';

type Metric = keyof Pick<
  Telemetry,
  'powerOutputKw' | 'windSpeedMs' | 'rotorRpm' | 'bladePitchDeg' | 'gearboxTempC'
>;

/** One chart per measured value (small multiples sharing the time axis). */
export const METRICS: { key: Metric; title: string; unit: string; decimals: number }[] = [
  { key: 'powerOutputKw', title: 'Power output', unit: 'kW', decimals: 0 },
  { key: 'windSpeedMs', title: 'Wind speed', unit: 'm/s', decimals: 1 },
  { key: 'rotorRpm', title: 'Rotor speed', unit: 'rpm', decimals: 1 },
  { key: 'bladePitchDeg', title: 'Blade pitch', unit: '°', decimals: 1 },
  { key: 'gearboxTempC', title: 'Gearbox temperature', unit: '°C', decimals: 1 },
];

/** /farms/:farmId/turbines/:turbineId: one turbine's status, charts per metric and readings. */
@Component({
  selector: 'app-turbine-page',
  imports: [
    AlertLevelBadge,
    DatePipe,
    DecimalPipe,
    RouterLink,
    LineChart,
    MatButton,
    MatButtonToggle,
    MatButtonToggleGroup,
    MatTooltip,
    StalenessBadge,
    TABLE_IMPORTS,
  ],
  templateUrl: './turbine-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TurbinePage implements OnDestroy {
  /** Bound from the route parameters (withComponentInputBinding). */
  readonly farmId = input.required<string>();
  readonly turbineId = input.required<string>();

  protected readonly store = inject(FleetStore);
  protected readonly ranges = HISTORY_RANGES;
  protected readonly gapMs = READING_INTERVAL_MS * 1.5; // one missing reading breaks the line
  /** Shared crosshair across all charts (epoch ms). */
  protected readonly hoverT = signal<number | null>(null);
  /** Shared zoomed time window across all charts (ECharts dataZoom), or null for all of it. */
  protected readonly view = signal<TimeRange | null>(null);

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
  protected readonly charts = computed(() => {
    const ascending = this.ascending();
    return METRICS.map((metric) => ({
      ...metric,
      points: ascending.map((r): ChartPoint => ({ t: Date.parse(r.timestamp), v: r[metric.key] })),
    }));
  });

  /**
   * The alerts chart: a line of how many rules each reading triggered (0, 1, 2…) with the flagged
   * readings as a scatter overlay, coloured by their worst level; the tooltip lists the rules.
   */
  protected readonly alertChart = computed(() => {
    const ascending = this.ascending();
    return {
      points: ascending.map((r): ChartPoint => ({
        t: Date.parse(r.timestamp),
        v: r.alerts.length,
      })),
      markers: ascending
        .filter((r) => r.alerts.length)
        .map((r): ChartMarker => ({
          t: Date.parse(r.timestamp),
          v: r.alerts.length,
          level: r.alerts[0].alertLevel, // worst first
          lines: r.alerts.map((rule) => describeTriggerWithLevel(r, rule)),
        })),
    };
  });

  protected readonly window = computed(() => this.store.historyWindow());

  /** The selected range in words, e.g. "24 hours" (for the empty state). */
  protected readonly rangeName = computed(
    () =>
      this.ranges.find((r) => r.ms === this.store.historyRangeMs())?.long ??
      `${Math.round(this.store.historyRangeMs() / 3_600_000)} hours`,
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
      untracked(() => {
        this.hoverT.set(null);
        this.view.set(null);
        this.store.select(id);
      });
    });
  }

  ngOnDestroy(): void {
    this.store.select(null);
  }

  protected setRange(ms: number): void {
    this.view.set(null);
    this.historyPaging.reset();
    this.store.select(this.turbineId(), ms);
  }

  /** Tooltip of a reading's Alerts cell: one line per triggered rule, worst first. */
  protected alertLines(reading: Telemetry): string {
    return reading.alerts.map(describeRuleWithLevel).join('\n');
  }

  protected delayMinutes(reading: Telemetry): number {
    return Math.round((Date.parse(reading.receivedAt) - Date.parse(reading.timestamp)) / 60_000);
  }

  protected isDelayed(reading: Telemetry): boolean {
    return Date.parse(reading.receivedAt) - Date.parse(reading.timestamp) > DELAYED_AFTER_MS;
  }
}
