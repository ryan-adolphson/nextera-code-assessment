import { Component, input } from '@angular/core';

/** One card of the skeleton: the chart's title and how many text lines sit above its plot. */
export interface ChartSkeletonCard {
  title: string;
  /** Lines between the title and the plot (candle size, legend, stats): 16px each. */
  lines: number;
}

/**
 * The size of a `ChartGroup` before ECharts has loaded (`@defer` placeholder and loading state):
 * one card per chart with the same border, padding, title row and `h-56` plot as `LineChart`, so
 * the page doesn't move when the charts replace it. It imports nothing from ECharts.
 */
@Component({
  selector: 'app-chart-skeleton',
  host: { class: 'block', 'data-testid': 'chart-skeleton' },
  template: `
    @if (loading()) {
      <p class="sr-only" role="status" data-testid="charts-loading">Loading charts…</p>
    }
    <div class="grid gap-3" aria-hidden="true">
      @for (card of cards(); track $index) {
        <div class="rounded-lg border border-line px-4 pt-3 pb-2" data-testid="chart-skeleton-card">
          <p class="m-0 text-sm leading-7 text-muted">{{ card.title }}</p>
          <!-- LineChart's text lines (text-xs, 1rem each); h-4 per line. -->
          @for (line of lineSlots(card.lines); track $index) {
            <div class="h-4"></div>
          }
          <div
            class="h-56 rounded bg-surface motion-safe:data-loading:animate-pulse"
            [attr.data-loading]="loading() ? '' : null"
          ></div>
        </div>
      }
    </div>
  `,
})
export class ChartSkeleton {
  readonly cards = input.required<ChartSkeletonCard[]>();
  /** The chunk is loading (announced; the plots pulse), rather than waiting for its trigger. */
  readonly loading = input(false);

  protected lineSlots(count: number): null[] {
    return Array<null>(count).fill(null);
  }
}
