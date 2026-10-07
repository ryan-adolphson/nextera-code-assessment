import {
  ChangeDetectionStrategy,
  Component,
  effect,
  input,
  signal,
  untracked,
} from '@angular/core';
import { MatButton } from '@angular/material/button';
import { minutesToMilliseconds } from 'date-fns';
import { AlertSeries } from './alert-series';
import { ChartKind, LineChart, RangeStats, TimeRange } from './line-chart';
import { ChartPoint } from './scales';

/** One metric chart of the group. */
export interface ChartSeries {
  key: string;
  title: string;
  unit: string;
  decimals: number;
  points: ChartPoint[];
  /** Median/high/low reference lines, or null for none. */
  stats?: RangeStats | null;
}

/**
 * Small multiples on one time axis: a `LineChart` per metric plus, optionally, the "Alert rules
 * triggered" chart (a line with the flagged times as a scatter overlay). The group owns the shared
 * crosshair (`hoverT`) and zoom (`view`) and a "Reset zoom" button shown while zoomed; both are
 * cleared whenever `resetKey` changes (another turbine, range or report).
 */
@Component({
  selector: 'app-chart-group',
  imports: [LineChart, MatButton],
  template: `
    <!-- Zoomed (brush, slider or Ctrl+wheel): one button brings every chart back to the range. -->
    @if (view()) {
      <div class="mb-2 flex justify-end">
        <button
          matButton="outlined"
          type="button"
          [attr.data-testid]="resetTestId()"
          (click)="view.set(null)"
        >
          Reset zoom
        </button>
      </div>
    }
    <section
      class="grid gap-3 transition-opacity data-refreshing:opacity-50"
      [attr.aria-label]="label()"
      [attr.data-testid]="testId()"
      [attr.data-refreshing]="refreshing() ? '' : null"
    >
      @for (chart of charts(); track chart.key) {
        <app-line-chart
          [kind]="kind()"
          [attr.data-metric]="chart.key"
          [title]="chart.title"
          [unit]="chart.unit"
          [decimals]="chart.decimals"
          [points]="chart.points"
          [domain]="domain()"
          [gapMs]="gapMs()"
          [hoverT]="hoverT()"
          (hoverTChange)="hoverT.set($event)"
          [view]="view()"
          (viewChange)="view.set($event)"
          [stats]="chart.stats ?? null"
        />
      }
      @if (alerts(); as alerts) {
        <app-line-chart
          data-metric="alerts"
          title="Alert rules triggered"
          [decimals]="0"
          [points]="alerts.points"
          [markers]="alerts.markers"
          [domain]="domain()"
          [gapMs]="gapMs()"
          [hoverT]="hoverT()"
          (hoverTChange)="hoverT.set($event)"
          [view]="view()"
          (viewChange)="view.set($event)"
        />
      }
    </section>
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChartGroup {
  readonly charts = input.required<ChartSeries[]>();
  readonly domain = input.required<TimeRange>();
  /** How the metric charts draw readings (the alerts chart is always a line). */
  readonly kind = input<ChartKind>('line');
  readonly alerts = input<AlertSeries | null>(null);
  /** Readings further apart than this are not connected. */
  readonly gapMs = input(minutesToMilliseconds(7.5));
  /** Changing it clears the crosshair and zoom (another turbine, range or report). */
  readonly resetKey = input<unknown>(null);
  /** Dims the charts while new data loads (the old ones stay until it arrives). */
  readonly refreshing = input(false);
  readonly label = input('Charts');
  readonly testId = input<string | null>(null);
  readonly resetTestId = input('reset-zoom');

  /** Shared crosshair (epoch ms) and zoomed window across the charts. */
  protected readonly hoverT = signal<number | null>(null);
  protected readonly view = signal<TimeRange | null>(null);

  constructor() {
    effect(() => {
      this.resetKey();
      untracked(() => {
        this.hoverT.set(null);
        this.view.set(null);
      });
    });
  }
}
