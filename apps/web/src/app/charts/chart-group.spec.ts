import { Component, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { AlertSeries } from './alert-series';
import { ChartGroup, ChartSeries } from './chart-group';
import { LineChart } from './line-chart';

const t0 = Date.parse('2026-01-02T03:00:00Z');
const MIN = 60_000;
const points = (...values: number[]) => values.map((v, i) => ({ t: t0 + i * 5 * MIN, v }));

@Component({
  imports: [ChartGroup],
  template: `
    <app-chart-group
      testId="group"
      label="Test charts"
      [charts]="charts"
      [alerts]="alerts()"
      [domain]="domain"
      [resetKey]="resetKey()"
    />
  `,
})
class Host {
  readonly charts: ChartSeries[] = [
    { key: 'power', title: 'Power output', unit: 'kW', decimals: 0, points: points(1, 2, 3) },
    {
      key: 'gearbox',
      title: 'Gearbox temperature',
      unit: '°C',
      decimals: 1,
      points: points(80, 81, 126.5),
    },
  ];
  readonly alerts = signal<AlertSeries | null>({
    points: points(0, 0, 1),
    markers: [{ t: t0 + 10 * MIN, v: 1, level: 'error', lines: ['Error: …'] }],
  });
  readonly domain = { from: t0, to: t0 + 10 * MIN };
  readonly resetKey = signal<unknown>('a');
}

describe('ChartGroup', () => {
  let fixture: ComponentFixture<Host>;
  let el: HTMLElement;
  beforeEach(async () => {
    fixture = TestBed.createComponent(Host);
    el = fixture.nativeElement;
    await fixture.whenStable();
  });
  const charts = () =>
    fixture.debugElement
      .queryAll((d) => d.name === 'app-line-chart')
      .map((d) => d.componentInstance as LineChart);

  it('draws a chart per metric plus the alerts chart, in a labelled section', () => {
    expect(charts().map((c) => c.title())).toEqual([
      'Power output',
      'Gearbox temperature',
      'Alert rules triggered',
    ]);
    expect(charts()[2].markers()).toHaveLength(1);
    expect(el.querySelector('[data-testid=group]')!.getAttribute('aria-label')).toBe('Test charts');
  });

  it('leaves the alerts chart out when there are no alerts series', async () => {
    fixture.componentInstance.alerts.set(null);
    await fixture.whenStable();
    expect(charts()).toHaveLength(2);
  });

  it('shares one crosshair across the charts', async () => {
    charts()[0].hoverAt(t0 + 6 * MIN); // snaps to 03:05
    await fixture.whenStable();
    expect(charts().map((c) => c.hoverT())).toEqual([t0 + 5 * MIN, t0 + 5 * MIN, t0 + 5 * MIN]);
  });

  it('shows Reset zoom while zoomed; it and a new resetKey bring every chart back', async () => {
    const zoom = async () => {
      charts()[1].onBrushEnd([t0, t0 + 10 * MIN - 1]); // a 30-min+ window inside the domain
      charts()[1].viewChange.emit({ from: t0, to: t0 + 9 * MIN });
      await fixture.whenStable();
    };
    expect(el.querySelector('[data-testid=reset-zoom]')).toBeNull();
    await zoom();
    expect(charts().map((c) => c.view())).toEqual(Array(3).fill({ from: t0, to: t0 + 9 * MIN }));

    el.querySelector<HTMLButtonElement>('[data-testid=reset-zoom]')!.click();
    await fixture.whenStable();
    expect(charts().map((c) => c.view())).toEqual([null, null, null]);
    expect(el.querySelector('[data-testid=reset-zoom]')).toBeNull();

    await zoom();
    fixture.componentInstance.resetKey.set('b'); // another turbine, range or report
    await fixture.whenStable();
    expect(charts().map((c) => c.view())).toEqual([null, null, null]);
  });
});
