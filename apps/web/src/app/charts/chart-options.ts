import { minutesToMilliseconds } from 'date-fns';
import { ChartTheme, withAlpha } from './chart-theme';

/** How the readings are drawn: a line, or candles of each time bucket (open/close/low/high). */
export type ChartKind = 'line' | 'candlestick';

/** Narrowest time window zooming can reach (6 readings at 5-minute intervals). */
export const MIN_X_RANGE_MS = minutesToMilliseconds(30);

/** What the static option needs from the chart component. */
export interface OptionHooks {
  /** Line charts: the symbol size of reading `index` (end dot, isolated readings). */
  symbolSize: (index: number) => number;
  /** Labels for the custom x tick values. */
  xLabel: (value: number) => string;
  /** The shared crosshair tooltip (text-only DOM). */
  tooltip: (params: unknown) => string | HTMLElement;
}

/**
 * The static ECharts option: axes, dataZoom (inside + slider), the driven axis tooltip and the
 * series in a fixed order (0 readings, a line or candlesticks; 1 hover dot; 2 marker scatter).
 * Data, colours and ticks are set later (render, `themeOption`, updateTicks).
 */
export function baseOption(kind: ChartKind, hooks: OptionHooks) {
  const candles = kind === 'candlestick';
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
          hooks.symbolSize(params.dataIndex),
        emphasis: { disabled: true },
        silent: true,
        markLine,
      };
  return {
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
        formatter: hooks.xLabel,
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
      formatter: hooks.tooltip,
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
  };
}

/** The theme colours of every part of the chart (re-applied when the colour scheme changes). */
export function themeOption(theme: ChartTheme, kind: ChartKind) {
  const label = { color: theme.muted };
  return {
    xAxis: { axisLine: { lineStyle: { color: theme.grid } }, axisLabel: label },
    yAxis: { splitLine: { lineStyle: { color: theme.grid } }, axisLabel: label },
    ...(kind === 'candlestick' && {
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
      kind === 'candlestick'
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
  };
}

/** Candlestick charts: a horizontal brush (one range at a time) over the time axis. */
export const BRUSH_OPTION = {
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
};

/** Turns the brush on, so dragging over the plot draws it (no toolbox button). */
export const BRUSH_CURSOR = {
  type: 'takeGlobalCursor',
  key: 'brush',
  brushOption: { brushType: 'lineX', brushMode: 'single' },
};
