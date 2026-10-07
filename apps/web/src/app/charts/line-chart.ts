import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  ElementRef,
  afterNextRender,
  computed,
  effect,
  inject,
  input,
  linkedSignal,
  output,
  untracked,
  viewChild,
} from '@angular/core';
import {
  CandlestickChart as CandlestickSeries,
  LineChart as LineSeries,
  ScatterChart as ScatterSeries,
} from 'echarts/charts';
import {
  BrushComponent,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  GridComponent,
  MarkLineComponent,
  TooltipComponent,
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';
import {
  Candle,
  ChartPoint,
  candleSizeFor,
  formatDuration,
  formatTimestamp,
  isIsolated,
  nearestIndex,
  paddedRange,
  ticksWithin,
  timeTicks,
  toCandles,
  withGapBreaks,
} from './scales';

/** How the readings are drawn: a line, or candles of each time bucket (open/close/low/high). */
export type ChartKind = 'line' | 'candlestick';

// Register only what a line chart needs, so the rest of ECharts is tree-shaken away.
echarts.use([
  LineSeries,
  ScatterSeries,
  CandlestickSeries,
  BrushComponent,
  GridComponent,
  TooltipComponent,
  DataZoomInsideComponent,
  DataZoomSliderComponent,
  MarkLineComponent,
  SVGRenderer,
]);

/** Time range [from, to] in epoch ms. */
export interface TimeRange {
  from: number;
  to: number;
}

/** Value range [min, max]. */
export interface ValueRange {
  min: number;
  max: number;
}

/** Summary of the values over the whole time range (drawn as reference lines). */
export interface RangeStats {
  median: number;
  high: number;
  low: number;
}

/**
 * The reference lines. Median is labelled at the start, high above and low below the line at the
 * end, so the labels never overlap, even when all three values are equal (a frozen sensor).
 */
const STAT_LINES = [
  { key: 'median', label: 'Median', position: 'insideStartTop' },
  { key: 'high', label: 'High', position: 'insideEndTop' },
  { key: 'low', label: 'Low', position: 'insideEndBottom' },
] as const;

/** Severity of a marker (the alert levels); worst first. */
export type MarkerLevel = 'error' | 'warn' | 'info';
const MARKER_LEVELS: readonly { level: MarkerLevel; label: string }[] = [
  { level: 'error', label: 'Error' },
  { level: 'warn', label: 'Warning' },
  { level: 'info', label: 'Info' },
];

/**
 * A point drawn over the line (scatter overlay), e.g. a reading that triggered alerts: at [t, v],
 * coloured by `level`; `lines` (text only) are added to the tooltip and the aria-label.
 */
export interface ChartMarker {
  t: number;
  v: number;
  level: MarkerLevel;
  lines: string[];
}

/** Theme colours, read from the app's CSS variables (re-read when light/dark mode changes). */
export interface ChartTheme {
  series: string;
  grid: string;
  text: string;
  muted: string;
  surface: string;
  /** Marker colours: the status tokens AlertLevelBadge uses (validated for light and dark). */
  levels: Record<MarkerLevel, string>;
}

function readTheme(): ChartTheme {
  const css = getComputedStyle(document.documentElement);
  const get = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
  return {
    series: get('--series-1', '#2a78d6'),
    grid: get('--border', '#e3e3e8'),
    text: get('--text', '#1a1a1a'),
    muted: get('--muted', '#6b6b6b'),
    surface: get('--bg', '#ffffff'),
    levels: {
      error: get('--danger', '#c92a2a'),
      warn: get('--warn', '#e67700'),
      info: get('--accent', '#3b5bdb'),
    },
  };
}

/** Narrowest time window zooming can reach (6 readings at 5-minute intervals). */
const MIN_X_RANGE_MS = 30 * 60_000;

/**
 * Single-series line chart (Apache ECharts, SVG renderer) for one metric over time; small
 * multiples share `domain`.
 * - 2px line that breaks at gaps (missing readings are shown, not interpolated); isolated
 *   readings as dots; an 8px end dot with a surface ring; latest value labelled in the header.
 * - The y-axis spans the data range ±10%, so the line never touches the frame. Hairline grid,
 *   round y ticks and UTC time ticks (our own tick values via `customValues`).
 * - Crosshair + tooltip snapping to the nearest reading. `hoverT` is an input/output pair so
 *   several charts share one crosshair. Keyboard: focus the chart, then ←/→, Home/End, Esc.
 * - Optional `stats` (median/high/low of the whole selected range, not the zoomed window) as
 *   dashed horizontal reference lines, also listed under the title and in the aria-label.
 * - Time-axis zoom (ECharts dataZoom): a slider under the plot, plus drag to pan and
 *   Ctrl+wheel/pinch to zoom inside it (a plain wheel still scrolls the page). The window is
 *   shared through the `view` input/output pair, so the small multiples stay aligned.
 * - Optional `markers`: a scatter overlay (10px dots with a surface ring, coloured by level) for
 *   points of interest such as readings that triggered alerts; a legend names the levels shown,
 *   and each marker's `lines` join the tooltip and the aria-label (colour is never the only cue).
 * - With `decimals` 0 (counts), the y-axis ticks are whole numbers.
 * - `kind: 'candlestick'`: the readings become UTC-aligned candles (open = first, close = last
 *   reading of each bucket, plus low/high; the size adapts to the range, about 24–48 candles),
 *   hollow when rising and solid when falling (no red/green: those are status colours); the
 *   crosshair snaps to candle centres. Dragging over the plot draws a horizontal brush (ECharts
 *   lineX) that zooms every chart to the brushed range (`viewChange`); panning is the slider's.
 * The tooltip content is built with textContent, so labels can never inject markup.
 */
@Component({
  selector: 'app-line-chart',
  host: { class: 'block' },
  templateUrl: './line-chart.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class LineChart {
  readonly title = input.required<string>();
  readonly unit = input('');
  /** Ascending by t. */
  readonly points = input.required<ChartPoint[]>();
  /** Shared x-domain [from, to] in epoch ms. */
  readonly domain = input.required<TimeRange>();
  readonly decimals = input(1);
  /** Readings further apart than this are not connected. */
  readonly gapMs = input(7.5 * 60_000);
  /** Shared crosshair position (epoch ms), or null. */
  readonly hoverT = input<number | null>(null);
  readonly hoverTChange = output<number | null>();
  /** Shared zoomed time window, or null for the whole domain. */
  readonly view = input<TimeRange | null>(null);
  readonly viewChange = output<TimeRange | null>();
  /** Median/high/low over the whole time range, or null for no reference lines. */
  readonly stats = input<RangeStats | null>(null);
  /** Scatter overlay over the line (ascending by t), e.g. readings that triggered alerts. */
  readonly markers = input<ChartMarker[]>([]);
  /** Line or candlestick (fixed for the chart's lifetime: read when ECharts is created). */
  readonly kind = input<ChartKind>('line');

  private readonly plot = viewChild.required<ElementRef<HTMLElement>>('plot');
  private readonly destroyRef = inject(DestroyRef);
  /** The ECharts instance (exposed for tests). */
  chart?: echarts.ECharts;
  /** Index (in the series data) of the reading under the crosshair, -1 for none. */
  activeIndex = -1;
  private theme = readTheme();
  /** Labels for the current x tick values. */
  private xLabels = new Map<number, string>();

  /**
   * Crosshair position this chart acts on: follows `hoverT` (e.g. moved by another chart) but is
   * updated immediately on our own pointer/key input, so fast key repeats never act on a stale
   * position while the parent's update is still pending.
   */
  private readonly position = linkedSignal(() => this.hoverT());

  protected readonly visible = computed(() => {
    const { from, to } = this.domain();
    return this.points().filter((p) => p.t >= from && p.t <= to);
  });
  private readonly data = computed(() => withGapBreaks(this.visible(), this.gapMs()));
  /** Candle size for the domain (candlestick charts). */
  protected readonly candleMs = computed(() => {
    const { from, to } = this.domain();
    return candleSizeFor(to - from);
  });
  protected readonly candleLabel = computed(() => formatDuration(this.candleMs()));
  protected readonly candles = computed(() =>
    this.kind() === 'candlestick' ? toCandles(this.visible(), this.candleMs()) : [],
  );
  private readonly candleAt = computed(() => new Map(this.candles().map((c) => [c.t, c])));
  /** What the crosshair snaps to: the readings, or the candle centres (value = close). */
  private readonly targets = computed((): ChartPoint[] =>
    this.kind() === 'candlestick'
      ? this.candles().map((c) => ({ t: c.t, v: c.close }))
      : this.visible(),
  );
  protected readonly visibleMarkers = computed(() => {
    const { from, to } = this.domain();
    return this.markers().filter((m) => m.t >= from && m.t <= to);
  });
  private readonly markerAt = computed(() => new Map(this.visibleMarkers().map((m) => [m.t, m])));
  /** The marker levels shown, worst first, with their counts (the legend). */
  protected readonly markerLegend = computed(() =>
    MARKER_LEVELS.map(({ level, label }) => ({
      level,
      label,
      count: this.visibleMarkers().filter((m) => m.level === level).length,
    })).filter((entry) => entry.count > 0),
  );
  /** The reference lines shown: only alongside readings (an empty chart shows no lines). */
  protected readonly shownStats = computed(() => (this.visible().length ? this.stats() : null));
  /** The reference lines with their labels, e.g. "Median 81.9 °C". */
  protected readonly statLines = computed(() => {
    const stats = this.shownStats();
    return stats
      ? STAT_LINES.map((line) => ({
          ...line,
          value: stats[line.key],
          text: `${line.label} ${this.format(stats[line.key])} ${this.unit()}`.trim(),
        }))
      : [];
  });
  /**
   * Bounds of the y-axis: the data range ±10%. The reference lines are included, so they are
   * never clipped (e.g. while stats lag a live reading that slid the window).
   */
  readonly yBounds = computed((): ValueRange | null => {
    const values = this.visible().map((p) => p.v);
    if (!values.length) return null;
    values.push(...this.statLines().map((line) => line.value));
    return paddedRange(Math.min(...values), Math.max(...values));
  });
  protected readonly last = computed(() => this.visible().at(-1) ?? null);
  protected readonly hovered = computed(() => {
    const t = this.position();
    if (t === null) return null;
    const targets = this.targets();
    return targets[nearestIndex(targets, t)] ?? null;
  });
  protected readonly ariaLabel = computed(() => {
    const last = this.last();
    const hovered = this.hovered();
    const lines = this.statLines();
    const stats = lines.length
      ? ` Over the range: ${lines.map((line) => line.text).join(', ')}.`
      : '';
    const legend = this.markerLegend();
    const flagged = legend.length
      ? ` Flagged: ${legend.map((entry) => `${entry.count} ${entry.label}`).join(', ')}.`
      : '';
    const count =
      this.kind() === 'candlestick'
        ? `${this.visible().length} readings in ${this.candles().length} ${this.candleLabel()} candles.`
        : `${this.visible().length} readings.`;
    const summary = last
      ? `${this.title()}: latest ${this.format(last.v)} ${this.unit()} at ${formatTimestamp(last.t)}. ${count}${stats}${flagged}`
      : `${this.title()}: no readings in this range.`;
    if (!hovered) return summary;
    const candle = this.candleAt().get(hovered.t);
    if (candle) return `${summary} Selected: ${this.describeCandle(candle)}.`;
    const marker = this.markerAt().get(hovered.t);
    const details = marker?.lines.length ? ` ${marker.lines.join('. ')}.` : '';
    return `${summary} Selected: ${this.format(hovered.v)} ${this.unit()} at ${formatTimestamp(hovered.t)}.${details}`;
  });

  constructor() {
    afterNextRender(() => {
      this.chart = this.createChart();
      this.render();
      this.watchColorScheme();
    });

    // Data, domain, stats or formatting changed: redraw.
    effect(() => {
      this.data();
      this.domain();
      this.statLines();
      this.visibleMarkers();
      this.decimals();
      this.unit();
      untracked(() => this.render());
    });

    // Another chart zoomed or panned: follow it (cheap, no data re-sent while dragging).
    effect(() => {
      this.view();
      untracked(() => this.applyView());
    });

    // Crosshair moved (by us, another chart or the keyboard): mirror it in ECharts.
    effect(() => {
      this.hovered();
      untracked(() => this.showActive());
    });

    this.destroyRef.onDestroy(() => this.chart?.dispose());
  }

  protected format(v: number): string {
    return v.toLocaleString('en-US', {
      minimumFractionDigits: this.decimals(),
      maximumFractionDigits: this.decimals(),
    });
  }

  /** "Jan 2, 03:00–03:30 UTC: start 82.1, end 90.0, low 81.9, high 126.5 °C (4 readings)". */
  protected describeCandle(c: Candle): string {
    const values = (
      [
        ['open', 'start'],
        ['close', 'end'],
        ['low', 'low'],
        ['high', 'high'],
      ] as const
    )
      .map(([key, label]) => `${label} ${this.format(c[key])}`)
      .join(', ');
    const unit = this.unit() ? ` ${this.unit()}` : '';
    return `${candleSpan(c)}: ${values}${unit} (${c.count} ${c.count === 1 ? 'reading' : 'readings'})`;
  }

  /**
   * A brush ended (candlestick charts): zoom every chart to the brushed range and clear the brush.
   * A click or a range under the minimum zoom only clears it.
   */
  onBrushEnd(range: [number, number] | null): void {
    this.chart?.dispatchAction({ type: 'brush', areas: [] });
    if (!range) return;
    const domain = this.domain();
    const from = Math.max(Math.min(...range), domain.from);
    const to = Math.min(Math.max(...range), domain.to);
    if (to - from < MIN_X_RANGE_MS) return;
    this.viewChange.emit({ from, to });
  }

  /** The time window currently shown, and whether it is zoomed in from the whole domain. */
  visibleRange(): { range: TimeRange; zoomed: boolean } {
    const { from, to } = this.domain();
    const [zoom] = (this.chart?.getOption()['dataZoom'] as
      { start: number; end: number }[] | undefined) ?? [{ start: 0, end: 100 }];
    const at = (percent: number) => from + ((to - from) * percent) / 100;
    return {
      range: { from: at(zoom.start), to: at(zoom.end) },
      zoomed: zoom.start > 1e-6 || zoom.end < 100 - 1e-6,
    };
  }

  /** After a zoom or pan by the user: re-tick and share the window (null when unzoomed). */
  onZoomed(): void {
    this.updateTicks();
    const { range, zoomed } = this.visibleRange();
    this.viewChange.emit(zoomed ? range : null);
  }

  protected onKeydown(event: KeyboardEvent): void {
    const points = this.targets();
    if (!points.length) return;
    const current = this.hovered();
    const index = current ? points.indexOf(current) : points.length - 1;
    const next =
      event.key === 'ArrowLeft'
        ? Math.max(0, index - 1)
        : event.key === 'ArrowRight'
          ? Math.min(points.length - 1, index + 1)
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? points.length - 1
              : null;
    if (event.key === 'Escape') {
      this.moveTo(null);
    } else if (next !== null) {
      event.preventDefault();
      this.moveTo(points[next].t);
    }
  }

  protected onFocus(): void {
    const last = this.last();
    if (this.position() === null && last) this.moveTo(last.t);
  }

  protected moveTo(t: number | null): void {
    if (t === this.position()) return;
    this.position.set(t);
    this.hoverTChange.emit(t);
  }

  /** Pointer at time `t` (or off the plot): snap to the nearest reading and share it. */
  hoverAt(t: number | null): void {
    const points = this.targets();
    this.moveTo(t === null || !points.length ? null : points[nearestIndex(points, t)].t);
  }

  private render(): void {
    const chart = this.chart;
    if (!chart) return;
    const domain = this.domain();
    const bounds = this.yBounds();
    const data = this.data();
    const lastIndex = data.length - 1;
    chart.setOption({
      xAxis: { min: domain.from, max: domain.to },
      yAxis: { min: bounds?.min ?? null, max: bounds?.max ?? null },
      series: [
        {
          id: 'readings',
          data:
            this.kind() === 'candlestick'
              ? // [t, open, close, low, high] per candle
                this.candles().map((c) => [c.t, c.open, c.close, c.low, c.high])
              : // The last reading carries the ring; the rest are plain [t, v] pairs (null = gap).
                data.map((d, i) =>
                  i === lastIndex
                    ? {
                        value: [d.x, d.y],
                        itemStyle: { borderColor: this.theme.surface, borderWidth: 2 },
                      }
                    : [d.x, d.y],
                ),
          markLine: { data: this.markLineData() },
        },
        {
          id: 'markers',
          data: this.visibleMarkers().map((m) => ({
            value: [m.t, m.v],
            itemStyle: { color: this.theme.levels[m.level] },
          })),
        },
      ],
    });
    this.applyView();
    this.showActive(true);
  }

  /** The stats as dashed horizontal lines, labelled with name and value (theme colours). */
  private markLineData() {
    return this.statLines().map((line) => {
      const color = line.key === 'median' ? this.theme.text : this.theme.muted;
      return {
        name: line.label,
        yAxis: line.value,
        lineStyle: { color },
        // A function, not a template string: ECharts would interpret `{…}` in a string.
        label: {
          position: line.position,
          color,
          // A surface-coloured backing keeps the label readable where it crosses the line.
          backgroundColor: this.theme.surface,
          padding: [1, 3],
          borderRadius: 2,
          formatter: () => line.text,
        },
      };
    });
  }

  /** Shows the shared window without emitting `datazoom` (it came from the parent). */
  private applyView(): void {
    const chart = this.chart;
    if (!chart) return;
    const { from, to } = clampRange(this.view(), this.domain());
    const current = this.visibleRange().range;
    if (Math.abs(current.from - from) > 1 || Math.abs(current.to - to) > 1) {
      chart.dispatchAction(
        { type: 'dataZoom', dataZoomIndex: 0, startValue: from, endValue: to },
        { silent: true },
      );
    }
    this.updateTicks();
  }

  /** Our own round y ticks and UTC time ticks for the visible window and chart width. */
  private updateTicks(): void {
    const chart = this.chart;
    if (!chart) return;
    const { from, to } = this.visibleRange().range;
    const y = this.yBounds();
    const xTicks = timeTicks(from, to, chart.getWidth() || 640);
    this.xLabels = new Map(xTicks.map((tick) => [tick.t, tick.label]));
    const xValues = xTicks.map((tick) => tick.t);
    // Counts (no decimals) get whole-number ticks only.
    const yValues = (y ? ticksWithin(y.min, y.max) : []).filter(
      (v) => this.decimals() > 0 || Number.isInteger(v),
    );
    chart.setOption({
      xAxis: { axisLabel: { customValues: xValues }, axisTick: { customValues: xValues } },
      yAxis: { axisLabel: { customValues: yValues }, axisTick: { customValues: yValues } },
    });
  }

  /** Shows the crosshair, tooltip and hover dot at the current position (or hides them). */
  private showActive(force = false): void {
    const chart = this.chart;
    if (!chart) return;
    const hovered = this.hovered();
    const candles = this.kind() === 'candlestick';
    const index = !hovered
      ? -1
      : candles
        ? this.candles().findIndex((c) => c.t === hovered.t)
        : this.data().findIndex((d) => d.x === hovered.t);
    if (!force && index === this.activeIndex) return;
    this.activeIndex = index;

    // Candles need no hover dot: the crosshair and tooltip mark the candle.
    chart.setOption({
      series: [{ id: 'hover', data: hovered && !candles ? [[hovered.t, hovered.v]] : [] }],
    });
    chart.dispatchAction(
      index >= 0 ? { type: 'showTip', seriesIndex: 0, dataIndex: index } : { type: 'hideTip' },
    );
  }

  private createChart(): echarts.ECharts {
    const element = this.plot().nativeElement;
    const chart = echarts.init(element, null, { renderer: 'svg' });
    const isolated = (index: number) => isIsolated(this.data(), index);
    const isLast = (index: number) => index === this.data().length - 1;
    const candles = this.kind() === 'candlestick';
    // Median/high/low reference lines: decoration only, never hovered or in the tooltip.
    const markLine = {
      data: [],
      silent: true,
      symbol: 'none',
      animation: false,
      emphasis: { disabled: true },
      tooltip: { show: false },
      lineStyle: { type: 'dashed', width: 1 },
      label: { show: true, fontSize: 10, distance: 2 },
    };
    const readings = candles
      ? {
          id: 'readings',
          type: 'candlestick',
          data: [],
          barMaxWidth: 14,
          itemStyle: { borderWidth: 1.5 },
          emphasis: { disabled: true },
          silent: true,
          markLine,
        }
      : {
          id: 'readings',
          type: 'line',
          data: [],
          connectNulls: false, // nulls break the line: gaps stay visible
          lineStyle: { width: 2, cap: 'round', join: 'round' },
          symbol: 'circle',
          showSymbol: true,
          showAllSymbol: true,
          symbolSize: (_value: unknown, params: { dataIndex: number }) =>
            isLast(params.dataIndex) ? 8 : isolated(params.dataIndex) ? 5 : 0,
          emphasis: { disabled: true },
          silent: true,
          markLine,
        };

    chart.setOption({
      animation: false,
      // ECharts 6 keeps the axis labels inside the chart (grid `outerBoundsMode: 'auto'`).
      grid: { left: 4, right: 12, top: 10, bottom: 54 }, // bottom: time labels + slider
      xAxis: {
        type: 'value',
        splitLine: { show: false },
        axisTick: { show: false },
        axisLabel: {
          fontSize: 11,
          hideOverlap: true,
          formatter: (value: number) => this.xLabels.get(value) ?? '',
        },
      },
      yAxis: {
        type: 'value',
        axisLine: { show: false },
        axisTick: { show: false },
        splitLine: { lineStyle: { width: 1 } },
        axisLabel: {
          fontSize: 11,
          formatter: (value: number) => value.toLocaleString('en-US', { maximumFractionDigits: 2 }),
        },
      },
      // Time axis only: drag to pan and Ctrl+wheel (trackpad pinch sends ctrlKey) or touch
      // pinch to zoom inside the plot, plus a slider under it. `filterMode: 'none'` keeps the
      // line running to the edges and the y-axis steady.
      dataZoom: [
        {
          type: 'inside',
          id: 'inside',
          xAxisIndex: 0,
          filterMode: 'none',
          minValueSpan: MIN_X_RANGE_MS,
          zoomOnMouseWheel: 'ctrl',
          moveOnMouseMove: !candles, // candlestick: dragging draws the brush instead
          moveOnMouseWheel: false,
        },
        {
          type: 'slider',
          id: 'slider',
          xAxisIndex: 0,
          filterMode: 'none',
          minValueSpan: MIN_X_RANGE_MS,
          height: 18,
          bottom: 6,
          left: 48,
          right: 16,
          showDetail: false, // the axis labels and tooltip already show the times
          brushSelect: false,
        },
      ],
      tooltip: {
        trigger: 'axis',
        triggerOn: 'none', // we drive it (pointer, keyboard, other charts) via showTip
        borderWidth: 1,
        padding: [6, 8],
        extraCssText: 'box-shadow: none; border-radius: 6px;',
        axisPointer: { type: 'line', snap: true, lineStyle: { width: 1, type: 'solid' } },
        formatter: (params: unknown) => {
          const [first] = params as { value: [number, number | null] }[];
          const [t, v] = first?.value ?? [];
          const candle = t == null ? undefined : this.candleAt().get(t);
          if (candle) return candleTooltip(candle, (key) => this.format(candle[key]), this.unit());
          return t == null || v == null
            ? ''
            : tooltipContent(
                `${this.format(v)} ${this.unit()}`,
                t,
                this.markerAt().get(t)?.lines ?? [],
              );
        },
      },
      series: [
        readings,
        {
          id: 'hover', // the reading under the crosshair
          type: 'line',
          data: [],
          symbol: 'circle',
          symbolSize: 8,
          showSymbol: true,
          emphasis: { disabled: true },
          silent: true,
          z: 3,
          tooltip: { show: false },
        },
        {
          id: 'markers', // the scatter overlay (last, so series 0/1 stay readings/hover): drawn on top by z
          type: 'scatter',
          data: [],
          symbol: 'circle',
          symbolSize: 10,
          itemStyle: { borderWidth: 2 },
          emphasis: { disabled: true },
          silent: true,
          z: 4,
          tooltip: { show: false },
        },
      ],
    });
    this.applyTheme(chart, this.theme);

    if (candles) {
      // Drag over the plot to brush a time range (lineX), which zooms every chart to it.
      chart.setOption({
        brush: {
          id: 'brush',
          xAxisIndex: 0,
          brushType: 'lineX',
          brushMode: 'single',
          transformable: false,
          removeOnClick: true,
          throttleType: 'debounce',
          throttleDelay: 0,
        },
      });
      chart.dispatchAction({
        type: 'takeGlobalCursor',
        key: 'brush',
        brushOption: { brushType: 'lineX', brushMode: 'single' },
      });
      chart.on('brushEnd', (event) => {
        const [area] = (event as { areas?: { coordRange?: [number, number] }[] }).areas ?? [];
        this.onBrushEnd(area?.coordRange ?? null);
      });
    }

    // Pointer → shared crosshair.
    chart.getZr().on('mousemove', (e) => {
      const point = [e.offsetX, e.offsetY];
      if (!chart.containPixel({ gridIndex: 0 }, point)) return;
      const [t] = chart.convertFromPixel({ gridIndex: 0 }, point) as number[];
      this.hoverAt(t);
    });
    chart.on('datazoom', () => this.onZoomed());

    // ECharts' inside dataZoom cancels every wheel event over the plot, even without Ctrl (it
    // checks `zoomOnMouseWheel: 'ctrl'` only after cancelling), so the page would stop scrolling
    // over the charts. Only Ctrl+wheel (and trackpad pinch, which sends ctrlKey) reaches ECharts.
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) event.stopPropagation();
    };
    element.addEventListener('wheel', onWheel, { capture: true });
    this.destroyRef.onDestroy(() => element.removeEventListener('wheel', onWheel, true));

    const resize = new ResizeObserver(() => {
      chart.resize();
      this.updateTicks();
    });
    resize.observe(element);
    this.destroyRef.onDestroy(() => resize.disconnect());
    return chart;
  }

  private applyTheme(chart: echarts.ECharts, theme: ChartTheme): void {
    const label = { color: theme.muted };
    chart.setOption({
      xAxis: { axisLine: { lineStyle: { color: theme.grid } }, axisLabel: label },
      yAxis: { splitLine: { lineStyle: { color: theme.grid } }, axisLabel: label },
      ...(this.kind() === 'candlestick' && {
        brush: {
          id: 'brush',
          brushStyle: {
            color: withAlpha(theme.series, 0.12),
            borderColor: theme.series,
            borderWidth: 1,
          },
        },
      }),
      tooltip: {
        backgroundColor: theme.surface,
        borderColor: theme.grid,
        axisPointer: { lineStyle: { color: theme.muted } },
      },
      dataZoom: [
        { id: 'inside' },
        {
          id: 'slider',
          backgroundColor: 'transparent',
          borderColor: theme.grid,
          fillerColor: withAlpha(theme.series, 0.12),
          dataBackground: {
            lineStyle: { color: theme.muted, opacity: 0.6, width: 1 },
            areaStyle: { opacity: 0 },
          },
          selectedDataBackground: {
            lineStyle: { color: theme.series, width: 1 },
            areaStyle: { opacity: 0 },
          },
          handleStyle: { color: theme.surface, borderColor: theme.muted },
          moveHandleStyle: { color: theme.grid, opacity: 1 },
          emphasis: {
            handleStyle: { borderColor: theme.series },
            moveHandleStyle: { color: theme.muted },
          },
        },
      ],
      series: [
        this.kind() === 'candlestick'
          ? {
              id: 'readings',
              // Rising candles hollow (surface fill), falling solid: one hue, no red/green.
              itemStyle: {
                color: theme.surface,
                color0: theme.series,
                borderColor: theme.series,
                borderColor0: theme.series,
              },
            }
          : {
              id: 'readings',
              lineStyle: { color: theme.series },
              itemStyle: { color: theme.series },
            },
        {
          id: 'hover',
          itemStyle: { color: theme.series, borderColor: theme.surface, borderWidth: 2 },
        },
        { id: 'markers', itemStyle: { borderColor: theme.surface } },
      ],
    });
  }

  /** Re-reads theme colours when the OS switches between light and dark mode. */
  private watchColorScheme(): void {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    if (!media) return;
    const apply = () => {
      if (!this.chart) return;
      this.theme = readTheme();
      this.applyTheme(this.chart, this.theme);
      this.render();
    };
    media.addEventListener('change', apply);
    this.destroyRef.onDestroy(() => media.removeEventListener('change', apply));
  }
}

/**
 * Tooltip: the value (bold, text ink) first, then the UTC time, then any marker lines (e.g. the
 * alerts that fired). Text only, never HTML.
 */
function tooltipContent(value: string, t: number, lines: readonly string[] = []): HTMLElement {
  const root = document.createElement('div');
  root.className = 'text-xs leading-5';
  const strong = document.createElement('strong');
  strong.className = 'block text-ink';
  strong.textContent = value;
  const time = document.createElement('span');
  time.className = 'text-muted';
  time.textContent = formatTimestamp(t);
  root.append(strong, time);
  for (const line of lines) {
    const item = document.createElement('span');
    item.className = 'block text-ink';
    item.textContent = line;
    root.append(item);
  }
  return root;
}

/** The zoomed window clipped to the domain; the whole domain when not zoomed (or no overlap). */
function clampRange(view: TimeRange | null, domain: TimeRange): TimeRange {
  if (!view) return domain;
  const from = Math.max(view.from, domain.from);
  const to = Math.min(view.to, domain.to);
  return from < to ? { from, to } : domain;
}

/** `#rrggbb` + alpha as `rgba()` (other colour formats are returned unchanged). */
function withAlpha(color: string, alpha: number): string {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (!hex) return color;
  const [r, g, b] = hex.slice(1).map((h) => parseInt(h, 16));
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** "Jan 2, 03:00–03:30 UTC": a candle's time span. */
function candleSpan(c: Candle): string {
  const end = formatTimestamp(c.end).replace(/^[A-Z][a-z]{2} \d{1,2}, /, '');
  return formatTimestamp(c.start).replace(' UTC', `–${end}`);
}

/**
 * Candle tooltip: start/end (the open/close: first and last reading of the period), low and high (text ink, aligned figures) with the unit, then the time
 * span and the number of readings. Text only, never HTML.
 */
function candleTooltip(
  c: Candle,
  format: (key: 'open' | 'close' | 'low' | 'high') => string,
  unit: string,
): HTMLElement {
  const root = document.createElement('div');
  root.className = 'text-xs leading-5';
  for (const [key, label] of [
    ['open', 'Start'],
    ['close', 'End'],
    ['low', 'Low'],
    ['high', 'High'],
  ] as const) {
    const row = document.createElement('span');
    row.className = 'flex justify-between gap-3 text-ink tabular-nums';
    const name = document.createElement('span');
    name.className = 'text-muted';
    name.textContent = label;
    const value = document.createElement('strong');
    value.textContent = `${format(key)} ${unit}`.trim();
    row.append(name, value);
    root.append(row);
  }
  const time = document.createElement('span');
  time.className = 'block text-muted';
  time.textContent = `${candleSpan(c)} · ${c.count} ${c.count === 1 ? 'reading' : 'readings'}`;
  root.append(time);
  return root;
}
