import { TestRequest } from '@angular/common/http/testing';
import { DeferBlockBehavior, DeferBlockState, TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { LineChart } from '../charts/line-chart';
import { TimeZoneSettings } from '../core/time-zone';
import { TEST_API_BASE_URL, openFleet } from '../fleet/testing';
import { FarmDailyDay, FarmDailyHistory } from './farm-history.model';

/** 2026-01-03T00:00Z: Jan 3 in UTC, Jan 2, 18:00 in Chicago (the pinned browser zone). */
const CLOCK = Date.parse('2026-01-03T00:00:00.000Z');
const MIN = 60_000;
const DAILY_URL = (farmId: string) => `${TEST_API_BASE_URL}/farms/${farmId}/telemetry/daily`;

const ohlc = (open: number, close: number, low: number, high: number) => ({
  open,
  close,
  low,
  high,
});
const day = (date: string, overrides: Partial<FarmDailyDay> = {}): FarmDailyDay => ({
  date,
  turbines: 1,
  readings: 288,
  powerOutputKw: ohlc(1500, 1800, 0, 2400),
  windSpeedMs: ohlc(7, 8, 3, 15.8),
  rotorRpm: ohlc(12, 13, 0, 16),
  bladePitchDeg: ohlc(2, 3, 0, 44),
  gearboxTempC: ohlc(80, 82, 70, 126.5),
  ...overrides,
});
/** The seed's two days (TURB001 on FARM01). */
const seedDays = (): FarmDailyDay[] => [
  day('2026-01-01', { powerOutputKw: ohlc(1500, 1800, 0, 2400) }),
  day('2026-01-02', { powerOutputKw: ohlc(1800, 1200, 300, 2100), readings: 270 }),
];

describe('FarmHistoryPage (/farms/:farmId/history)', () => {
  let app: Awaited<ReturnType<typeof openFleet>>;
  let now: number;

  async function open(
    url = '/farms/FARM01/history',
    timeZone: 'utc' | 'local' = 'utc',
    deferBlockBehavior = DeferBlockBehavior.Playthrough,
  ) {
    now = CLOCK;
    app = await openFleet(url, () => now, undefined, undefined, 'viewer', {
      timeZone,
      deferBlockBehavior,
    });
  }
  afterEach(() => app.http.verify());

  const q = <T extends Element = HTMLElement>(id: string) =>
    app.root().querySelector<T>(`[data-testid=${id}]`);
  /** The pending daily request (sent on the next change detection). */
  const expectDaily = (farmId = 'FARM01'): TestRequest => {
    TestBed.tick();
    return app.http.expectOne((r) => r.method === 'GET' && r.url === DAILY_URL(farmId));
  };
  const expectNoDaily = (farmId = 'FARM01') => {
    TestBed.tick();
    app.http.expectNone(DAILY_URL(farmId));
  };
  const params = (req: TestRequest) =>
    ['from', 'to', 'timeZone'].map((name) => req.request.params.get(name));
  /** Answers with the API's shape: the request echoed. */
  async function answer(
    req: TestRequest,
    days: FarmDailyDay[] = seedDays(),
    extra: Partial<FarmDailyHistory> = {},
  ) {
    const [from, to, timeZone] = params(req);
    req.flush({
      farmId: req.request.url.split('/').at(-3)!,
      from: from!,
      to: to!,
      timeZone: timeZone!,
      turbineCount: 2,
      computedAt: '2026-01-02T23:45:00.000Z',
      days,
      ...extra,
    } satisfies FarmDailyHistory);
    await app.stable();
  }
  const fail = async (req: TestRequest) => {
    req.flush('boom', { status: 500, statusText: 'Server Error' });
    await app.stable();
  };
  const pickRange = async (id: '30d' | '90d' | '6m') => {
    q(`farm-history-range-${id}`)!.querySelector('button')!.click();
    TestBed.tick();
  };
  const charts = () =>
    app.harness.fixture.debugElement
      .queryAll((d) => d.name === 'app-line-chart')
      .map((d) => d.componentInstance as LineChart);
  const navigate = async (url: string) => {
    await TestBed.inject(Router).navigateByUrl(url);
    TestBed.tick();
  };

  it('asks for the last 30 UTC days ending today, and says when the figures were computed', async () => {
    await open();
    const req = expectDaily();
    expect(params(req)).toEqual(['2025-12-05T00:00:00.000Z', '2026-01-04T00:00:00.000Z', 'UTC']);
    expect(req.request.headers.get('Authorization')).toBe('Bearer test-token-viewer');
    expect(app.text(q('farm-history-status'))).toBe('Loading daily history…');
    await answer(req);

    expect(app.text(q('farm-history-status'))).toBe(
      'Updated Jan 2, 23:45 UTC. Daily figures refresh every 15 minutes.',
    );
    expect(app.text(q('farm-history-note'))).toBe('Daily figures refresh every 15 minutes.');
    const range = q('farm-history-range')!;
    expect(range.getAttribute('aria-label')).toBe('History range');
    expect(
      [...range.querySelectorAll('button')].map((b) => [
        app.text(b),
        b.getAttribute('aria-checked'),
      ]),
    ).toEqual([
      ['30d', 'true'],
      ['90d', 'false'],
      ['6 months', 'false'],
    ]);
    expect(TestBed.inject(Title).getTitle()).toBe('Prairie Ridge · History · Nextera');
    expect(app.text(app.root().querySelector('h1'))).toBe('Prairie Ridge FARM01');
  });

  it('draws one daily candlestick chart of the farm’s power output only', async () => {
    await open();
    await answer(expectDaily());

    const group = q('farm-history-charts')!;
    expect(group.getAttribute('aria-label')).toBe('Farm history charts');
    expect(
      [...group.querySelectorAll('app-line-chart')].map((c) => c.getAttribute('data-metric')),
    ).toEqual(['powerOutputKw']);
    const [chart] = charts();
    expect([chart.title(), chart.unit(), chart.kind(), chart.candleLabel()]).toEqual([
      'Farm power output',
      'kW',
      'candlestick',
      'Daily',
    ]);
    expect(chart.domain()).toEqual({
      from: Date.parse('2025-12-05T00:00:00.000Z'),
      to: Date.parse('2026-01-04T00:00:00.000Z'),
    });
    // One candle per UTC day, centred at noon: [centre, open, close, low, high].
    const series = (chart.chart!.getOption()['series'] as { data: unknown[] }[])[0];
    expect(series.data).toEqual([
      [Date.parse('2026-01-01T12:00:00Z'), 1500, 1800, 0, 2400],
      [Date.parse('2026-01-02T12:00:00Z'), 1800, 1200, 300, 2100],
    ]);
    expect(app.text(group.querySelector('[data-testid=candle-size]'))).toBe(
      'Daily candles · drag across the chart to zoom',
    );
  });

  it('shows the day, its open/close/low/high and “N of M turbines reporting” in the tooltip', async () => {
    await open();
    await answer(expectDaily());
    const [chart] = charts();
    chart.hoverAt(Date.parse('2026-01-02T08:00:00Z'));
    await app.stable();

    const tooltip = (
      chart.chart!.getOption() as unknown as {
        tooltip: { formatter: (params: unknown) => HTMLElement }[];
      }
    ).tooltip[0].formatter([
      { value: [Date.parse('2026-01-02T12:00:00Z'), 1800, 1200, 300, 2100] },
    ]);
    expect([...tooltip.children].map((c) => c.textContent)).toEqual([
      'Start1,800 kW',
      'End1,200 kW',
      'Low300 kW',
      'High2,100 kW',
      'Fri, Jan 2, 2026 · 1 of 2 turbines reporting',
    ]);
    expect(
      app
        .root()
        .querySelector('[data-metric=powerOutputKw] [role=img]')!
        .getAttribute('aria-label'),
    ).toBe(
      'Farm power output: latest 1,200 kW at Fri, Jan 2, 2026. 558 readings in 2 daily candles. ' +
        'Selected: Fri, Jan 2, 2026: start 1,800, end 1,200, low 300, high 2,100 kW (1 of 2 turbines reporting).',
    );
  });

  it('asks for 90 days or 6 months on the toggle, and reuses an answer when switching back', async () => {
    await open();
    await answer(expectDaily());

    await pickRange('90d');
    const ninety = expectDaily();
    expect(params(ninety)).toEqual(['2025-10-06T00:00:00.000Z', '2026-01-04T00:00:00.000Z', 'UTC']);
    await answer(ninety, [day('2025-11-01'), ...seedDays()]);
    expect(charts()[0].domain().from).toBe(Date.parse('2025-10-06T00:00:00.000Z'));
    expect(q('farm-history-range-90d')!.querySelector('button')!.getAttribute('aria-checked')).toBe(
      'true',
    );

    await pickRange('6m');
    const half = expectDaily();
    // 182 whole days (the API allows at most 183).
    expect(params(half)).toEqual(['2025-07-06T00:00:00.000Z', '2026-01-04T00:00:00.000Z', 'UTC']);
    await answer(half);

    // Back to 30 days: cached (fresh), so no request.
    await pickRange('30d');
    expectNoDaily();
    await app.stable();
    expect(charts()[0].domain().from).toBe(Date.parse('2025-12-05T00:00:00.000Z'));
    expect(
      (charts()[0].chart!.getOption()['series'] as { data: unknown[] }[])[0].data,
    ).toHaveLength(2);
  });

  it('asks again for whole local days when the zone changes', async () => {
    await open();
    await answer(expectDaily());

    TestBed.inject(TimeZoneSettings).setMode('local');
    const req = expectDaily();
    // Jan 2, 18:00 CST is "today": 30 local days from Dec 4, 00:00 CST.
    expect(params(req)).toEqual([
      '2025-12-04T06:00:00.000Z',
      '2026-01-03T06:00:00.000Z',
      'America/Chicago',
    ]);
    await answer(req);
    expect(app.text(q('farm-history-updated'))).toBe('Updated Jan 2, 17:45 CST.');
    // Days are local midnights: Jan 1 starts at 06:00 UTC.
    const series = (charts()[0].chart!.getOption()['series'] as { data: unknown[][] }[])[0];
    expect(series.data[0][0]).toBe(Date.parse('2026-01-01T18:00:00Z'));

    // Back to UTC: the cached UTC answer.
    TestBed.inject(TimeZoneSettings).setMode('utc');
    expectNoDaily();
  });

  it('reuses the answer across tab switches for 15 minutes, then asks again', async () => {
    await open();
    await answer(expectDaily());

    await navigate('/farms/FARM01');
    await app.stable();
    await navigate('/farms/FARM01/history');
    expectNoDaily();
    await app.stable();
    expect(q('farm-history-charts')).not.toBeNull();

    // 14:59 later: still fresh.
    now = CLOCK + 14 * MIN + 59_000;
    await navigate('/farms/FARM01/weather');
    await app.stable();
    await navigate('/farms/FARM01/history');
    expectNoDaily();
    await app.stable();

    // 15 minutes after it was loaded: stale, so one request.
    now = CLOCK + 15 * MIN;
    await navigate('/farms/FARM01');
    await app.stable();
    await navigate('/farms/FARM01/history');
    await answer(expectDaily());
    expect(q('farm-history-charts')).not.toBeNull();
  });

  it('keeps each farm’s answers apart', async () => {
    await open();
    await answer(expectDaily());
    await navigate('/farms/FARM02/history');
    await answer(expectDaily('FARM02'), [day('2026-01-02')]);
    expect(app.text(app.root().querySelector('h1'))).toBe('High Plains FARM02');
    expect(TestBed.inject(Title).getTitle()).toBe('High Plains · History · Nextera');
  });

  it('Refresh skips the cache', async () => {
    await open();
    await answer(expectDaily());
    q<HTMLButtonElement>('farm-history-refresh')!.click();
    const req = expectDaily();
    expect(params(req)[0]).toBe('2025-12-05T00:00:00.000Z');
    // Dimmed while it reloads; the old chart stays.
    TestBed.tick();
    expect(q('farm-history-charts')!.hasAttribute('data-refreshing')).toBe(true);
    // Disabled but still focusable (disabledInteractive), so a keyboard user keeps their place.
    const button = q<HTMLButtonElement>('farm-history-refresh')!;
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.disabled).toBe(false);
    // A second press while it loads sends nothing.
    button.click();
    TestBed.tick();
    app.http.expectNone(DAILY_URL('FARM01'));
    await answer(req, seedDays(), { computedAt: '2026-01-03T00:00:00.000Z' });
    expect(app.text(q('farm-history-updated'))).toBe('Updated Jan 3, 00:00 UTC.');
    expect(q('farm-history-refresh')!.hasAttribute('aria-disabled')).toBe(false);
  });

  describe('focus when Retry or Refresh goes away', () => {
    const focused = () => document.activeElement as HTMLElement | null;
    const press = (id: string) => {
      const button = q<HTMLButtonElement>(id)!;
      button.focus();
      button.click();
    };

    it('keeps focus on Refresh while it reloads, and moves it to Retry when the reload fails', async () => {
      await open();
      await answer(expectDaily());
      press('farm-history-refresh');
      const req = expectDaily();
      TestBed.tick(); // (stable() would wait for the answer)
      expect(focused()).toBe(q('farm-history-refresh'));

      await fail(req);
      expect(q('farm-history-refresh')).toBeNull();
      expect(focused()).toBe(q('farm-history-retry'));
    });

    it('moves focus from Retry to Refresh (aria-disabled while loading) when there is history', async () => {
      await open();
      await answer(expectDaily());
      press('farm-history-refresh');
      await fail(expectDaily());

      press('farm-history-retry');
      const req = expectDaily();
      TestBed.tick();
      expect(q('farm-history-retry')).toBeNull();
      expect(focused()).toBe(q('farm-history-refresh'));
      await answer(req);
      expect(focused()).toBe(q('farm-history-refresh'));
    });

    it('moves focus from Retry to the selected range when nothing has loaded yet', async () => {
      await open();
      await fail(expectDaily());
      expect(q('farm-history-refresh')).toBeNull();

      press('farm-history-retry');
      const req = expectDaily();
      TestBed.tick();
      expect(app.text(q('farm-history-status'))).toBe('Loading daily history…');
      expect(focused()).toBe(q('farm-history-range-30d')!.querySelector('button'));
      await answer(req);
    });

    it('leaves focus alone when the user has moved on', async () => {
      await open();
      await answer(expectDaily());
      press('farm-history-refresh');
      const req = expectDaily();
      const back = q<HTMLAnchorElement>('back-to-farms')!;
      back.focus();
      await fail(req);
      expect(focused()).toBe(back);
    });
  });

  it('shows an error with Retry, which asks again even after an earlier answer was cached', async () => {
    await open();
    await answer(expectDaily());
    await pickRange('90d');
    await fail(expectDaily());

    expect(app.text(q('farm-history-error'))).toBe('The daily history could not be loaded. Retry');
    expect(q('farm-history-error')!.getAttribute('role')).toBe('alert');
    expect(q('farm-history-charts')).toBeNull();
    expect(q('farm-history-refresh')).toBeNull();

    q<HTMLButtonElement>('farm-history-retry')!.click();
    const retry = expectDaily();
    expect(params(retry)[0]).toBe('2025-10-06T00:00:00.000Z');
    await answer(retry);
    expect(q('farm-history-error')).toBeNull();
    expect(q('farm-history-charts')).not.toBeNull();

    // A failed 30-day retry bypasses its fresh cached answer too.
    await pickRange('30d');
    expectNoDaily();
    await app.stable();
    q<HTMLButtonElement>('farm-history-refresh')!.click();
    await fail(expectDaily());
    q<HTMLButtonElement>('farm-history-retry')!.click();
    await answer(expectDaily());
    expect(q('farm-history-error')).toBeNull();
  });

  it('says when the farm has no daily history yet', async () => {
    await open();
    await answer(expectDaily(), [], { computedAt: null });
    expect(app.text(q('farm-history-empty'))).toBe('No daily history yet for this farm.');
    // Announced: it appears inside a status region that was already on the page.
    expect(q('farm-history-empty')!.parentElement!.getAttribute('role')).toBe('status');
    expect(q('farm-history-updated')).toBeNull();
    expect(app.text(q('farm-history-status'))).toBe('Daily figures refresh every 15 minutes.');
    expect(q('farm-history-charts')).toBeNull();
    expect(q('chart-skeleton')).toBeNull();
  });

  it('shows only “not found” for an unknown farm, without asking the API', async () => {
    await open('/farms/FARM99/history');
    expectNoDaily('FARM99');
    await app.stable();
    expect(app.text(q('farm-not-found'))).toBe('Farm FARM99 was not found.');
    expect(q('farm-tabs')).toBeNull();
    expect(q('farm-history-range')).toBeNull();
    expect(TestBed.inject(Title).getTitle()).toBe('FARM99 · History · Nextera');
  });

  describe('while the charts chunk loads (@defer)', () => {
    async function openManual() {
      await open('/farms/FARM01/history', 'utc', DeferBlockBehavior.Manual);
      await answer(expectDaily());
    }
    const block = async () => (await app.harness.fixture.getDeferBlocks())[0];

    it('keeps the chart’s size with a skeleton card until ECharts loads', async () => {
      await openManual();
      expect(q('farm-history-charts')).toBeNull();
      const cards = [...app.root().querySelectorAll('[data-testid=chart-skeleton-card]')];
      expect(cards.map((c) => app.text(c))).toEqual(['Farm power output']);

      await (await block()).render(DeferBlockState.Loading);
      await app.stable();
      expect(app.text(q('charts-loading'))).toBe('Loading charts…');

      await (await block()).render(DeferBlockState.Complete);
      await app.stable();
      expect(q('farm-history-charts')).not.toBeNull();
    });

    it('asks for a reload when the charts chunk fails', async () => {
      await openManual();
      await (await block()).render(DeferBlockState.Error);
      await app.stable();
      expect(app.text(q('charts-load-error'))).toBe(
        'The charts could not be loaded. Reload the page to try again.',
      );
    });
  });
});
