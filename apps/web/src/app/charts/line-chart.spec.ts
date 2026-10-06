import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { LineChart, RangeStats, TimeRange } from './line-chart';
import { ChartPoint } from './scales';

const MIN = 60_000;
const t0 = Date.parse('2026-01-02T03:00:00Z');
const at = (minute: number, v: number): ChartPoint => ({ t: t0 + minute * MIN, v });

/** Two charts sharing one crosshair and one zoomed time window, as on the turbine page. */
@Component({
  imports: [LineChart],
  template: `
    @for (series of [gearbox(), power()]; track $index) {
      <app-line-chart
        [title]="$index ? 'Power output' : 'Gearbox temperature'"
        [unit]="$index ? 'kW' : '°C'"
        [decimals]="$index ? 0 : 1"
        [points]="series"
        [domain]="domain()"
        [hoverT]="hoverT()"
        (hoverTChange)="hoverT.set($event)"
        [view]="view()"
        (viewChange)="view.set($event)"
        [stats]="$index ? powerStats() : gearboxStats()"
      />
    }
  `,
})
class Host {
  // The TURB002 gearbox anomaly: 03:20–03:30 stuck at 126.5 °C, with 03:10 missing.
  readonly gearbox = signal([
    at(0, 82.1),
    at(5, 81.9),
    at(15, 82.1),
    at(20, 126.5),
    at(25, 126.5),
    at(30, 126.5),
    at(35, 81.9),
  ]);
  readonly power = signal([
    at(0, 2046),
    at(5, 2160),
    at(15, 2046),
    at(20, 2200),
    at(25, 2200),
    at(30, 2200),
    at(35, 2160),
  ]);
  readonly domain = signal({ from: t0, to: t0 + 35 * MIN });
  readonly hoverT = signal<number | null>(null);
  readonly view = signal<TimeRange | null>(null);
  readonly gearboxStats = signal<RangeStats | null>(null);
  readonly powerStats = signal<RangeStats | null>(null);
}

/** The parts of ECharts' resolved option the tests read. */
interface Axis {
  min: number;
  max: number;
  axisLabel: { customValues: number[]; formatter: (value: number) => string };
  axisTick: { customValues: number[] };
}
type DataItem = [number, number | null] | { value: [number, number | null] };
interface MarkLineItem {
  name: string;
  yAxis: number;
  lineStyle: { color: string };
  label: { position: string; color: string; formatter: () => string };
}
interface MarkLine {
  data: MarkLineItem[];
  silent: boolean;
  symbol: string;
  tooltip: { show: boolean };
  lineStyle: { type: string; width: number };
}
interface Option {
  xAxis: Axis[];
  yAxis: Axis[];
  series: {
    type: string;
    data: DataItem[];
    connectNulls: boolean;
    lineStyle: { width: number };
    markLine: MarkLine;
  }[];
  dataZoom: Record<string, unknown>[];
  tooltip: { formatter: (params: unknown) => string | HTMLElement }[];
  legend?: unknown;
}

describe('LineChart (ECharts)', () => {
  let fixture: ComponentFixture<Host>;
  let host: Host;
  let el: HTMLElement;

  beforeEach(async () => {
    fixture = TestBed.createComponent(Host);
    host = fixture.componentInstance;
    el = fixture.nativeElement;
    await fixture.whenStable();
  });

  const components = () =>
    fixture.debugElement.children.map((c) => c.componentInstance as LineChart);
  const chartOf = (i: number) => components()[i].chart!;
  const optionOf = (i: number) => chartOf(i).getOption() as unknown as Option;
  const plotOf = (i: number) => el.querySelectorAll<HTMLElement>('[role=img]')[i];
  const values = (i: number) =>
    optionOf(i).series[0].data.map((d) => (Array.isArray(d) ? d : d.value));
  const text = (i: number, selector: string) =>
    el
      .querySelectorAll('app-line-chart')
      [i].querySelector(selector)
      ?.textContent?.replace(/\s+/g, ' ')
      .trim();

  it('labels the chart with its title and latest value', () => {
    expect(text(0, '[data-testid=chart-title]')).toBe('Gearbox temperature');
    expect(text(0, '[data-testid=latest]')).toBe('81.9 °C');
    expect(text(1, '[data-testid=latest]')).toBe('2,160 kW');
  });

  it('draws one 2px line series (plus the hover dot) without a legend', () => {
    const option = optionOf(0);
    expect(option.series.map((s) => s.type)).toEqual(['line', 'line']);
    expect(option.series[0].lineStyle.width).toBe(2);
    expect(option.legend).toBeUndefined();
  });

  it('breaks the line at missing readings instead of interpolating', () => {
    expect(optionOf(0).series[0].connectNulls).toBe(false);
    expect(values(0).map(([, v]) => v)).toEqual([
      82.1,
      81.9,
      null, // 03:10 is missing
      82.1,
      126.5,
      126.5,
      126.5,
      81.9,
    ]);
  });

  it('uses the shared time domain', () => {
    expect(optionOf(0).xAxis[0].min).toBe(t0);
    expect(optionOf(0).xAxis[0].max).toBe(t0 + 35 * MIN);
  });

  it('pads the y-axis by 10% of the data range, with round ticks and grid lines inside', () => {
    const y = optionOf(0).yAxis[0]; // gearbox 81.9–126.5 °C
    expect(y.min).toBeCloseTo(77.44);
    expect(y.max).toBeCloseTo(130.96);
    expect(y.axisLabel.customValues).toEqual([80, 90, 100, 110, 120, 130]);
    expect(y.axisTick.customValues).toEqual([80, 90, 100, 110, 120, 130]); // drives split lines
  });

  it('never pads non-negative values below zero (power 0–3,500 kW)', async () => {
    host.power.set([at(0, 0), at(5, 3500)]);
    await fixture.whenStable();

    const y = optionOf(1).yAxis[0];
    expect([y.min, y.max]).toEqual([0, 3850]);
    expect(y.axisLabel.customValues).toEqual([0, 1000, 2000, 3000]);
  });

  it('labels the time axis in UTC', () => {
    const { customValues, formatter } = optionOf(0).xAxis[0].axisLabel;
    const labels = customValues.map((value) => formatter(value));
    expect(labels).toContain('03:00');
    expect(labels).toContain('03:30');
  });

  it('describes itself for screen readers (the plot has no text of its own)', () => {
    expect(plotOf(0).getAttribute('role')).toBe('img');
    expect(plotOf(0).getAttribute('aria-label')).toBe(
      'Gearbox temperature: latest 81.9 °C at Jan 2, 03:35 UTC. 7 readings.',
    );
  });

  it('hovering one chart activates the same reading, with tooltip, on every chart', async () => {
    const showTip = vi.spyOn(chartOf(1), 'dispatchAction');
    components()[0].hoverAt(t0 + 21 * MIN); // snaps to 03:20
    await fixture.whenStable();

    expect(host.hoverT()).toBe(t0 + 20 * MIN);
    for (const i of [0, 1]) {
      expect(components()[i].activeIndex).toBe(4); // index 2 is the gap
    }
    expect(optionOf(0).series[1].data).toEqual([[t0 + 20 * MIN, 126.5]]);
    expect(optionOf(1).series[1].data).toEqual([[t0 + 20 * MIN, 2200]]);
    expect(showTip).toHaveBeenCalledWith({ type: 'showTip', seriesIndex: 0, dataIndex: 4 });
    expect(plotOf(1).getAttribute('aria-label')).toContain(
      'Selected: 2,200 kW at Jan 2, 03:20 UTC',
    );

    components()[0].hoverAt(null);
    await fixture.whenStable();
    expect(host.hoverT()).toBeNull();
    expect(components()[1].activeIndex).toBe(-1);
    expect(optionOf(1).series[1].data).toEqual([]);
    expect(showTip).toHaveBeenLastCalledWith({ type: 'hideTip' });
  });

  it('formats the tooltip as text (never HTML), value first, then the time', () => {
    const { formatter } = optionOf(0).tooltip[0];
    const content = formatter([{ value: [t0 + 20 * MIN, 126.5] }]) as unknown as HTMLElement;
    expect([...content.children].map((c) => [c.tagName, c.textContent])).toEqual([
      ['STRONG', '126.5 °C'],
      ['SPAN', 'Jan 2, 03:20 UTC'],
    ]);
  });

  it('is keyboard accessible: focus shows the latest reading, arrows step through readings', async () => {
    const plot = plotOf(0);
    plot.dispatchEvent(new FocusEvent('focus'));
    await fixture.whenStable();
    expect(host.hoverT()).toBe(t0 + 35 * MIN);

    plot.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
    await fixture.whenStable();
    expect(host.hoverT()).toBe(t0 + 30 * MIN);

    plot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    await fixture.whenStable();
    expect(host.hoverT()).toBe(t0);

    plot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await fixture.whenStable();
    expect(host.hoverT()).toBeNull();
  });

  it('handles fast key repeats without waiting for the next render', async () => {
    const plot = plotOf(0);
    plot.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home' }));
    for (let i = 0; i < 3; i++) {
      plot.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' })); // no render in between
    }
    await fixture.whenStable();

    expect(host.hoverT()).toBe(t0 + 20 * MIN); // 4th reading (03:10 is missing)
  });

  it('updates the chart when new readings arrive', async () => {
    host.gearbox.update((points) => [...points, at(40, 83)]);
    host.domain.set({ from: t0, to: t0 + 40 * MIN });
    await fixture.whenStable();

    expect(values(0).at(-1)).toEqual([t0 + 40 * MIN, 83]);
    expect(optionOf(0).xAxis[0].max).toBe(t0 + 40 * MIN);
    expect(text(0, '[data-testid=latest]')).toBe('83.0 °C');
  });

  it('only plots readings inside the shared time range', async () => {
    host.domain.set({ from: t0 + 18 * MIN, to: t0 + 35 * MIN });
    await fixture.whenStable();
    expect(plotOf(0).getAttribute('aria-label')).toContain('4 readings');
  });

  it('says so when the range has no readings', async () => {
    host.domain.set({ from: t0 + 100 * MIN, to: t0 + 200 * MIN });
    await fixture.whenStable();
    expect(text(0, '[data-testid=chart-empty]')).toBe('No readings in this range');
  });

  describe('dataZoom (time axis)', () => {
    /** A user gesture: a non-silent dataZoom action emits `datazoom` like dragging does. */
    const gesture = async (i: number, zoom: Record<string, number>) => {
      chartOf(i).dispatchAction({ type: 'dataZoom', ...zoom });
      await fixture.whenStable();
    };
    const window = (i: number) => components()[i].visibleRange().range;

    it('has a slider and inside zoom on the time axis only', () => {
      const [inside, slider, ...rest] = optionOf(0).dataZoom;
      expect(rest).toEqual([]);
      expect(inside).toMatchObject({
        type: 'inside',
        filterMode: 'none',
        minValueSpan: 30 * MIN,
        zoomOnMouseWheel: 'ctrl', // a plain wheel still scrolls the page
        moveOnMouseMove: true, // drag to pan
        moveOnMouseWheel: false,
      });
      expect(slider).toMatchObject({ type: 'slider', filterMode: 'none', minValueSpan: 30 * MIN });
      for (const zoom of [inside, slider]) {
        expect(zoom['xAxisIndex']).toBe(0);
        expect(zoom['yAxisIndex']).toBeUndefined();
      }
    });

    it('lets a plain wheel scroll the page; only Ctrl+wheel reaches ECharts', () => {
      const svg = plotOf(0).querySelector('svg')!;
      const reached = vi.fn();
      svg.addEventListener('wheel', reached);

      svg.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
      expect(reached).not.toHaveBeenCalled();

      svg.dispatchEvent(
        new WheelEvent('wheel', { deltaY: 100, ctrlKey: true, bubbles: true, cancelable: true }),
      );
      expect(reached).toHaveBeenCalledTimes(1);
    });

    it('shares the zoomed window with the other charts, with time ticks to match', async () => {
      await gesture(0, { dataZoomIndex: 1, startValue: t0 + 5 * MIN, endValue: t0 + 35 * MIN });

      expect(host.view()!.from).toBeCloseTo(t0 + 5 * MIN, -1);
      expect(host.view()!.to).toBeCloseTo(t0 + 35 * MIN, -1);
      expect(window(1).from).toBeCloseTo(t0 + 5 * MIN, -1);
      expect(window(1).to).toBeCloseTo(t0 + 35 * MIN, -1);
      for (const i of [0, 1]) {
        const ticks = optionOf(i).xAxis[0].axisLabel.customValues;
        expect(ticks.length).toBeGreaterThan(0);
        expect(ticks.every((t) => t >= t0 + 5 * MIN && t <= t0 + 35 * MIN)).toBe(true);
      }
    });

    it('never zooms in below 30 minutes', async () => {
      await gesture(0, { dataZoomIndex: 0, startValue: t0 + 10 * MIN, endValue: t0 + 20 * MIN });
      expect(host.view()!.to - host.view()!.from).toBeCloseTo(30 * MIN, -1);
    });

    it('shares null once zoomed all the way out again', async () => {
      await gesture(0, { dataZoomIndex: 0, startValue: t0 + 5 * MIN, endValue: t0 + 35 * MIN });
      await gesture(0, { dataZoomIndex: 0, start: 0, end: 100 });

      expect(host.view()).toBeNull();
      expect(window(1)).toEqual({ from: t0, to: t0 + 35 * MIN });
    });

    it('keeps the window while live readings arrive, clipped to the time range', async () => {
      await gesture(0, { dataZoomIndex: 0, startValue: t0 + 5 * MIN, endValue: t0 + 35 * MIN });
      host.gearbox.update((points) => [...points, at(40, 83)]);
      host.domain.set({ from: t0 + 20 * MIN, to: t0 + 60 * MIN });
      await fixture.whenStable();

      expect(window(0).from).toBeCloseTo(t0 + 20 * MIN, -1);
      expect(window(0).to).toBeCloseTo(t0 + 50 * MIN, -1); // widened to the 30-minute minimum
    });

    it('keeps the y-axis on the whole range while zoomed', async () => {
      const before = optionOf(0).yAxis[0];
      await gesture(0, { dataZoomIndex: 0, startValue: t0 + 5 * MIN, endValue: t0 + 35 * MIN });
      expect(optionOf(0).yAxis[0].min).toBe(before.min);
      expect(optionOf(0).yAxis[0].max).toBe(before.max);
    });
  });

  describe('stats (median, high, low reference lines)', () => {
    // Over the whole range: median 82.1, high 126.5 (the frozen gearbox), low 81.9.
    const gearbox: RangeStats = { median: 82.1, high: 126.5, low: 81.9 };
    const markLine = (i: number) => optionOf(i).series[0].markLine;
    const lines = (i: number) =>
      markLine(i).data.map((d) => [d.name, d.yAxis, d.label.position, d.label.formatter()]);

    it('draws no reference lines without stats', () => {
      expect(markLine(0).data).toEqual([]);
      expect(el.querySelector('[data-testid=stats]')).toBeNull();
    });

    it('draws three dashed, silent horizontal lines labelled with value and unit', async () => {
      host.gearboxStats.set(gearbox);
      host.powerStats.set({ median: 2160, high: 2200, low: 2046 });
      await fixture.whenStable();

      expect(lines(0)).toEqual([
        ['Median', 82.1, 'insideStartTop', 'Median 82.1 °C'],
        ['High', 126.5, 'insideEndTop', 'High 126.5 °C'],
        ['Low', 81.9, 'insideEndBottom', 'Low 81.9 °C'],
      ]);
      expect(lines(1).map(([, , , label]) => label)).toEqual([
        'Median 2,160 kW', // the chart's own decimals (0) and unit
        'High 2,200 kW',
        'Low 2,046 kW',
      ]);
      expect(markLine(0)).toMatchObject({
        silent: true, // never hovered: the crosshair and tooltip stay on the readings
        symbol: 'none',
        tooltip: { show: false },
        lineStyle: { type: 'dashed', width: 1 },
      });
      // Still one line series plus the hover dot: the lines are part of the readings series.
      expect(optionOf(0).series.map((s) => s.type)).toEqual(['line', 'line']);
    });

    it('lists the values under the title and in the aria-label', async () => {
      host.gearboxStats.set(gearbox);
      await fixture.whenStable();

      expect(text(0, '[data-testid=stat-median]')).toBe('82.1 °C');
      expect(text(0, '[data-testid=stat-high]')).toBe('126.5 °C');
      expect(text(0, '[data-testid=stat-low]')).toBe('81.9 °C');
      expect(text(0, '[data-testid=stats]')).toBe('Median 82.1 °C High 126.5 °C Low 81.9 °C');
      expect(plotOf(0).getAttribute('aria-label')).toBe(
        'Gearbox temperature: latest 81.9 °C at Jan 2, 03:35 UTC. 7 readings. ' +
          'Over the range: Median 82.1 °C, High 126.5 °C, Low 81.9 °C.',
      );
      expect(text(1, '[data-testid=stats]')).toBeUndefined(); // power has none
    });

    it('widens the y-axis so a line is never clipped', async () => {
      // e.g. stats still covering a reading that has just slid out of the window
      host.gearboxStats.set({ median: 82.1, high: 140, low: 60 });
      await fixture.whenStable();

      const y = optionOf(0).yAxis[0];
      expect(y.min).toBeCloseTo(52); // 60 - 10% of 80
      expect(y.max).toBeCloseTo(148);
    });

    it('keeps the y-axis on the data when the stats lie inside it', async () => {
      const before = optionOf(0).yAxis[0];
      host.gearboxStats.set(gearbox);
      await fixture.whenStable();

      expect(optionOf(0).yAxis[0].min).toBe(before.min);
      expect(optionOf(0).yAxis[0].max).toBe(before.max);
    });

    it('removes the lines when the stats go away (or there are no readings)', async () => {
      host.gearboxStats.set(gearbox);
      await fixture.whenStable();
      host.gearboxStats.set(null);
      await fixture.whenStable();
      expect(markLine(0).data).toEqual([]);
      expect(text(0, '[data-testid=stats]')).toBeUndefined();

      host.gearboxStats.set(gearbox);
      host.domain.set({ from: t0 + 100 * MIN, to: t0 + 200 * MIN });
      await fixture.whenStable();
      expect(markLine(0).data).toEqual([]);
      expect(text(0, '[data-testid=stats]')).toBeUndefined();
    });

    it('leaves the crosshair, tooltip and zoom working', async () => {
      host.gearboxStats.set(gearbox);
      await fixture.whenStable();

      components()[0].hoverAt(t0 + 21 * MIN);
      await fixture.whenStable();
      expect(components()[0].activeIndex).toBe(4);
      expect(optionOf(0).series[1].data).toEqual([[t0 + 20 * MIN, 126.5]]);

      chartOf(0).dispatchAction({
        type: 'dataZoom',
        dataZoomIndex: 0,
        startValue: t0 + 5 * MIN,
        endValue: t0 + 35 * MIN,
      });
      await fixture.whenStable();
      expect(host.view()!.from).toBeCloseTo(t0 + 5 * MIN, -1);
      expect(markLine(0).data).toHaveLength(3); // the lines describe the whole range
    });

    it('colours the lines from the theme’s CSS variables', async () => {
      const root = document.documentElement.style;
      root.setProperty('--text', '#111111');
      root.setProperty('--muted', '#777777');
      try {
        const themed = TestBed.createComponent(Host);
        themed.componentInstance.gearboxStats.set(gearbox);
        await themed.whenStable();
        const chart = (themed.debugElement.children[0].componentInstance as LineChart).chart!;
        const option = chart.getOption() as unknown as Option;

        expect(
          option.series[0].markLine.data.map((d) => [d.name, d.lineStyle.color, d.label.color]),
        ).toEqual([
          ['Median', '#111111', '#111111'],
          ['High', '#777777', '#777777'],
          ['Low', '#777777', '#777777'],
        ]);
      } finally {
        root.removeProperty('--text');
        root.removeProperty('--muted');
      }
    });
  });

  it('disposes its ECharts instance with the component', () => {
    const chart = chartOf(0);
    const dispose = vi.spyOn(chart, 'dispose');
    fixture.destroy();
    expect(dispose).toHaveBeenCalled();
  });
});
