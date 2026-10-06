import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { of, throwError } from 'rxjs';
import { routes } from '../app.routes';
import { NOW } from '../core/clock';
import { SseService } from '../core/sse.service';
import { LineChart } from '../charts/line-chart';
import { FleetApi } from './fleet-api.service';
import { FarmOverview, TelemetryStats } from './fleet.model';
import { fakes, farmsFixture, reading, statsFixture } from './testing';

/** Drives the real routes: overview -> farm -> turbine, with fake API and SSE. */
describe('Fleet routes', () => {
  let harness: RouterTestingHarness;
  let api: ReturnType<typeof fakes>['api'];
  let sse: ReturnType<typeof fakes>['sse'];
  /** The client clock: 5 minutes after TURB001's latest reading (Jan 2, 23:55) unless changed. */
  const CLOCK = Date.parse('2026-01-03T00:00:00.000Z');
  let clockNow: number;
  beforeEach(() => (clockNow = CLOCK));

  async function start(
    url: string,
    history: ReturnType<typeof reading>[] = [],
    stats?: TelemetryStats,
    farms?: FarmOverview[],
  ) {
    ({ api, sse } = fakes(farms));
    api.telemetry.mockReturnValue(of(history));
    if (stats) api.telemetryStats.mockReturnValue(of(stats));
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes, withComponentInputBinding()),
        { provide: FleetApi, useValue: api },
        { provide: SseService, useValue: sse },
        { provide: NOW, useValue: () => clockNow },
      ],
    });
    harness = await RouterTestingHarness.create(url);
  }

  const el = () => harness.routeNativeElement!.parentElement!.parentElement as HTMLElement;
  const text = (selector: string) =>
    el().querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim();
  const cards = () => [...el().querySelectorAll<HTMLAnchorElement>('[data-testid=turbine-card]')];
  const stable = () => harness.fixture.whenStable();
  const staleness = (selector: string) =>
    el().querySelector(selector)?.getAttribute('data-staleness');
  const MINUTE = 60_000;
  /** Moves the client clock and fires the store's minute tick (fake timers must be on). */
  async function advanceClock(ms: number) {
    clockNow += ms;
    await vi.advanceTimersByTimeAsync(ms);
    await stable();
  }
  const fixture = () => harness.fixture;

  describe('overview (/farms)', () => {
    beforeEach(() => start('/farms'));

    it('shows fleet totals and every farm, including farms without turbines', () => {
      expect(text('[data-testid=fleet-power]')).toBe('4.2 MW');
      expect(text('[data-testid=fleet-reporting]')).toBe('2 / 2');

      const rows = [...el().querySelectorAll('[data-testid=farms] tbody tr')].map((row) =>
        [...row.querySelectorAll('td')].map((td) => td.textContent?.replace(/\s+/g, ' ').trim()),
      );
      expect(rows).toEqual([
        ['Prairie Ridge FARM01', '41.25, -96.53', '1', '1', '1,961', '6.7'],
        ['High Plains FARM02', '39.75, -101.22', '1', '1', '2,259', '8.5'],
        ['Red Canyon FARM03', '35.12, -106.55', '0', '–', '–', '–'],
      ]);
    });

    it('shows every farm on the map, coloured by status', () => {
      const marker = (id: string) => el().querySelector(`[data-marker-id="${id}"]`);
      expect(el().querySelectorAll('.map-marker')).toHaveLength(3);
      expect(marker('FARM01')!.classList).toContain('marker-ok');
      expect(marker('FARM03')!.classList).toContain('marker-empty');
    });

    it('updates fleet totals and farm markers as turbines go quiet', async () => {
      TestBed.resetTestingModule();
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        await start('/');
        const marker = (id: string) => el().querySelector(`[data-marker-id="${id}"]`)!.classList;

        await advanceClock(26 * MINUTE); // 31 min since 23:55
        expect(text('[data-testid=fleet-reporting]')).toBe('0 / 2');
        expect(marker('FARM01')).toContain('marker-stale-30');
        expect(marker('FARM03')).toContain('marker-empty');

        sse.push(
          reading({
            turbineId: 'TURB002',
            farmId: 'FARM02',
            timestamp: new Date(clockNow).toISOString(),
          }),
        );
        await stable();
        expect(text('[data-testid=fleet-reporting]')).toBe('1 / 2');
        expect(marker('FARM02')).toContain('marker-ok');
        expect(marker('FARM01')).toContain('marker-stale-30');
      } finally {
        vi.useRealTimers();
      }
    });

    it('opens a farm from its map marker', async () => {
      el()
        .querySelector('[data-marker-id="FARM02"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await stable();

      expect(text('h1')).toBe('High Plains FARM02');
    });

    it('shows the four marker colours with their labels in the legend', () => {
      const legend = [...el().querySelectorAll('[data-testid=legend] li')];
      expect(legend.map((li) => [li.getAttribute('data-status'), li.textContent?.trim()])).toEqual([
        ['ok', 'Reporting'],
        ['stale-15', 'No data in 15 min'],
        ['stale-30', 'No data in 30 min'],
        ['stale-60', 'No data in 60 min'],
        ['empty', 'No turbines or readings'],
      ]);
    });

    it('does not show turbines until a farm is chosen', () => {
      expect(cards()).toHaveLength(0);
    });

    it('opens a farm from its link', async () => {
      el().querySelector<HTMLAnchorElement>('[data-testid=farms] a')!.click();
      await stable();
      expect(text('h1')).toBe('Prairie Ridge FARM01');
    });

    it('opens a farm from anywhere on its row', async () => {
      el().querySelectorAll<HTMLTableRowElement>('[data-testid=farms] tbody tr')[1].click();
      await stable();

      expect(text('h1')).toBe('High Plains FARM02');
    });
  });

  describe('farm page (/farms/:farmId)', () => {
    it("lists only that farm's turbines with their latest readings", async () => {
      await start('/farms/FARM02');

      expect(text('h1')).toBe('High Plains FARM02');
      expect(text('[data-testid=farm-power]')).toBe('2,259 kW');
      expect(text('[data-testid=farm-reporting]')).toBe('1 / 1');
      expect(cards().map((c) => c.querySelector('strong')?.textContent)).toEqual(['TURB002']);
      expect(cards()[0].textContent).toContain('Wind 8.5 m/s');
    });

    it("shows the farm's turbines on the map; a marker opens the turbine page", async () => {
      await start('/farms/FARM01');
      expect(el().querySelectorAll('.map-marker')).toHaveLength(1);

      el()
        .querySelector('[data-marker-id="TURB001"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await stable();

      expect(text('h1')).toBe('TURB001 Prairie Ridge');
    });

    it('says so when the farm has no turbines', async () => {
      await start('/farms/FARM03');

      expect(text('h1')).toBe('Red Canyon FARM03');
      expect(text('[data-testid=no-turbines]')).toContain('No turbines are registered');
      expect(cards()).toHaveLength(0);
      // The map still shows where the farm is.
      expect(el().querySelector('[data-marker-id="FARM03"]')!.classList).toContain('marker-empty');
    });

    it('handles an unknown farm id', async () => {
      await start('/farms/FARM99');
      expect(text('[data-testid=farm-not-found]')).toBe('Farm FARM99 was not found.');
    });

    it('links each turbine card to its own page', async () => {
      await start('/farms/FARM01');
      expect(cards()[0].getAttribute('href')).toBe('/farms/FARM01/turbines/TURB001');

      cards()[0].click();
      await stable();

      expect(text('h1')).toBe('TURB001 Prairie Ridge');
    });

    it('updates a turbine card live', async () => {
      await start('/farms/FARM01');

      sse.push(reading({ timestamp: '2026-01-03T00:00:00.000Z', powerOutputKw: 3100 }));
      await stable();

      expect(cards()[0].textContent).toContain('3,100 kW');
      expect(cards()[0].hasAttribute('data-updated')).toBe(true);
    });

    it('moves the turbine cards through 15, 30 and 60 min on the clock alone', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true }); // timers only; the clock is NOW
      try {
        await start('/farms/FARM01'); // TURB001's latest (23:55) is 5 min old
        const badge = () => cards()[0].querySelector('[data-testid=staleness]');
        const marker = () => el().querySelector('[data-marker-id="TURB001"]')!.classList;
        expect(cards()[0].getAttribute('data-staleness')).toBe('ok');
        expect(badge()).toBeNull(); // reporting cards stay quiet

        await advanceClock(10 * MINUTE); // exactly 15 min: still reporting
        expect(cards()[0].getAttribute('data-staleness')).toBe('ok');

        const steps = [
          [1, 'stale-15', 'No data in 15 min', '0 / 1'], // 16 min
          [15, 'stale-30', 'No data in 30 min', '0 / 1'], // 31 min
          [30, 'stale-60', 'No data in 60 min', '0 / 1'], // 61 min
        ] as const;
        for (const [minutes, level, label, reporting] of steps) {
          await advanceClock(minutes * MINUTE);
          expect(cards()[0].getAttribute('data-staleness')).toBe(level);
          expect(badge()?.getAttribute('data-staleness')).toBe(level);
          expect(badge()?.textContent?.trim()).toBe(label);
          expect(marker()).toContain(`marker-${level}`);
          expect(text('[data-testid=farm-reporting]')).toBe(reporting);
        }

        sse.push(reading({ timestamp: new Date(clockNow).toISOString() }));
        await stable();
        expect(cards()[0].getAttribute('data-staleness')).toBe('ok');
        expect(text('[data-testid=farm-reporting]')).toBe('1 / 1');
      } finally {
        vi.useRealTimers();
      }
    });

    it('goes back to all farms', async () => {
      await start('/farms/FARM01');
      el().querySelector<HTMLAnchorElement>('[data-testid=back-to-farms]')!.click();
      await stable();

      expect(text('h1')).toBe('Fleet overview');
    });
  });

  describe('turbine page (/farms/:farmId/turbines/:turbineId)', () => {
    /** TURB001's last 20 minutes, with 23:45 missing. */
    const history = [
      reading({
        id: 'r4',
        timestamp: '2026-01-02T23:55:00.000Z',
        receivedAt: '2026-01-03T00:13:00.000Z',
        powerOutputKw: 1960.5,
        gearboxTempC: 79.3,
      }),
      reading({
        id: 'r3',
        timestamp: '2026-01-02T23:50:00.000Z',
        receivedAt: '2026-01-02T23:52:00.000Z',
        powerOutputKw: 2093.6,
        gearboxTempC: 79.6,
      }),
      reading({
        id: 'r1',
        timestamp: '2026-01-02T23:40:00.000Z',
        receivedAt: '2026-01-02T23:41:00.000Z',
        powerOutputKw: 2041.8,
        gearboxTempC: 81.4,
      }),
    ];
    const charts = () => [...el().querySelectorAll('app-line-chart')];

    it('shows a breadcrumb, the turbine and its status', async () => {
      await start('/farms/FARM01/turbines/TURB001', history);

      expect(
        [...el().querySelector('[data-testid=breadcrumb]')!.children].map((c) =>
          c.textContent?.trim(),
        ),
      ).toEqual(['All farms', '›', 'Prairie Ridge', '›', 'TURB001']);
      expect(text('h1')).toBe('TURB001 Prairie Ridge');
      expect(text('[data-testid=status] [data-testid=staleness]')).toBe('Reporting');
      expect(staleness('[data-testid=status] [data-testid=staleness]')).toBe('ok');
      expect(text('[data-testid=status]')).toContain('Latest reading Jan 2, 23:55 UTC');
    });

    it('adds nothing for a commissioned turbine and a quiet pill for one that is not', async () => {
      await start('/farms/FARM01/turbines/TURB001', history);
      expect(el().querySelector('[data-testid=not-commissioned]')).toBeNull();
      harness.fixture.destroy();
      TestBed.resetTestingModule();

      await start('/farms/FARM02/turbines/TURB002'); // not commissioned in the fixture
      expect(text('[data-testid=status] [data-testid=not-commissioned]')).toBe('Not commissioned');
    });

    it('flags a turbine that has not reported for over an hour in red', async () => {
      clockNow = CLOCK + 56 * MINUTE; // 61 min after the latest reading
      await start('/farms/FARM01/turbines/TURB001', history);

      expect(text('[data-testid=status] [data-testid=staleness]')).toBe('No data in 60 min');
      expect(staleness('[data-testid=status] [data-testid=staleness]')).toBe('stale-60');
      expect(text('[data-testid=status]')).toContain('Latest reading Jan 2, 23:55 UTC');
    });

    it('charts each value separately, in a fixed order, over the default 24h range', async () => {
      await start('/farms/FARM01/turbines/TURB001', history);

      expect(api.telemetry).toHaveBeenCalledWith(
        'TURB001',
        expect.objectContaining({ limit: 289 }),
      );
      expect(
        charts().map((c) => c.querySelector('[data-testid=chart-title]')?.textContent?.trim()),
      ).toEqual([
        'Power output',
        'Wind speed',
        'Rotor speed',
        'Blade pitch',
        'Gearbox temperature',
      ]);
      expect(charts()[0].querySelector('[data-testid=latest]')?.textContent?.trim()).toBe(
        '1,961 kW',
      );
      expect(charts()[4].querySelector('[data-testid=latest]')?.textContent?.trim()).toBe(
        '79.3 °C',
      );
      // The missing 23:45 reading breaks every line (a null point between 23:40 and 23:50).
      const chart = (
        fixture().debugElement.query((d) => d.name === 'app-line-chart')
          .componentInstance as LineChart
      ).chart!;
      const [readings] = chart.getOption()['series'] as {
        data: ([number, number | null] | { value: [number, number | null] })[];
      }[];
      expect(readings.data.map((d) => (Array.isArray(d) ? d : d.value)[1])).toEqual([
        2041.8,
        null,
        2093.6,
        1960.5,
      ]);
    });

    it('switches the time range for all charts from one control', async () => {
      await start('/farms/FARM01/turbines/TURB001', history);
      const buttons = [...el().querySelectorAll<HTMLButtonElement>('[data-testid=range] button')];
      expect(buttons.map((b) => b.textContent?.trim())).toEqual(['6h', '24h', '48h', '7d']);
      expect(buttons[1].getAttribute('aria-pressed')).toBe('true');

      buttons[3].click();
      await stable();

      expect(api.telemetry).toHaveBeenLastCalledWith(
        'TURB001',
        expect.objectContaining({ limit: 2016 }),
      );
      expect(buttons[3].getAttribute('aria-pressed')).toBe('true');
    });

    it('shares one crosshair across all five charts', async () => {
      await start('/farms/FARM01/turbines/TURB001', history);

      charts()[0].querySelector<HTMLElement>('[role=img]')!.dispatchEvent(new FocusEvent('focus'));
      await stable();

      const instances = fixture()
        .debugElement.queryAll((d) => d.name === 'app-line-chart')
        .map((d) => d.componentInstance as LineChart);
      expect(instances).toHaveLength(5);
      for (const chart of instances) {
        expect(chart.activeIndex).toBe(3); // the latest reading (index 1 is the 23:45 gap)
      }
    });

    describe('dataZoom', () => {
      const components = () =>
        fixture()
          .debugElement.queryAll((d) => d.name === 'app-line-chart')
          .map((d) => d.componentInstance as LineChart);
      const from = Date.parse('2026-01-02T23:00:00.000Z');
      const to = Date.parse('2026-01-02T23:50:00.000Z');

      /** A user gesture on one chart (emits `datazoom` like dragging the slider). */
      async function zoom(index: number) {
        components()[index].chart!.dispatchAction({
          type: 'dataZoom',
          dataZoomIndex: 1,
          startValue: from,
          endValue: to,
        });
        await stable();
      }

      it('zooms all five charts to the same time window', async () => {
        await start('/farms/FARM01/turbines/TURB001', history);
        await zoom(4);

        expect(components()).toHaveLength(5);
        for (const component of components()) {
          const { range, zoomed } = component.visibleRange();
          expect(zoomed).toBe(true);
          expect(range.from).toBeCloseTo(from, -2);
          expect(range.to).toBeCloseTo(to, -2);
        }
      });

      it('shows the whole range again when the time range changes', async () => {
        await start('/farms/FARM01/turbines/TURB001', history);
        await zoom(0);
        el().querySelectorAll<HTMLButtonElement>('[data-testid=range] button')[0].click();
        await stable();

        for (const component of components()) {
          expect(component.visibleRange()).toEqual({
            range: { from: CLOCK - 6 * 3_600_000, to: CLOCK },
            zoomed: false,
          });
        }
      });
    });

    describe('stats', () => {
      const stats = statsFixture({
        metrics: {
          powerOutputKw: { median: 2041.8, high: 2093.6, low: 1960.5 },
          windSpeedMs: { median: 7, high: 7, low: 7 },
          rotorRpm: { median: 12, high: 12, low: 12 },
          bladePitchDeg: { median: 4, high: 4, low: 4 },
          gearboxTempC: { median: 79.6, high: 81.4, low: 79.3 },
        },
      });
      const statsText = (chart: number) =>
        ['median', 'high', 'low'].map((key) =>
          charts()[chart].querySelector(`[data-testid=stat-${key}]`)?.textContent?.trim(),
        );
      const markLines = (chart: number) => {
        const instance = fixture().debugElement.queryAll((d) => d.name === 'app-line-chart')[chart]
          .componentInstance as LineChart;
        const [readings] = instance.chart!.getOption()['series'] as {
          markLine: { data: { name: string; yAxis: number }[] };
        }[];
        return readings.markLine.data.map((d) => [d.name, d.yAxis]);
      };

      it("loads the range's stats with the same window as the readings", async () => {
        await start('/farms/FARM01/turbines/TURB001', history, stats);

        const [, window] = api.telemetry.mock.calls[0] as unknown as [string, unknown];
        expect(api.telemetryStats).toHaveBeenCalledWith('TURB001', window);
      });

      it("shows each metric's median, high and low on its own chart", async () => {
        await start('/farms/FARM01/turbines/TURB001', history, stats);

        expect(statsText(0)).toEqual(['2,042 kW', '2,094 kW', '1,961 kW']);
        expect(statsText(4)).toEqual(['79.6 °C', '81.4 °C', '79.3 °C']);
        expect(markLines(4)).toEqual([
          ['Median', 79.6],
          ['High', 81.4],
          ['Low', 79.3],
        ]);
      });

      it('reloads the stats for a new time range', async () => {
        await start('/farms/FARM01/turbines/TURB001', history, stats);
        el().querySelectorAll<HTMLButtonElement>('[data-testid=range] button')[3].click();
        await stable();

        expect(api.telemetryStats).toHaveBeenLastCalledWith(
          'TURB001',
          expect.objectContaining({ limit: 2016 }),
        );
      });

      it('reloads the stats when a live reading for this turbine arrives', async () => {
        await start('/farms/FARM01/turbines/TURB001', history, stats);
        api.telemetryStats.mockReturnValue(
          of(statsFixture({}, { median: 2100, high: 3100, low: 1960.5 })),
        );

        sse.push(
          reading({ id: 'live', timestamp: '2026-01-03T00:00:00.000Z', powerOutputKw: 3100 }),
        );
        await stable();

        expect(statsText(0)).toEqual(['2,100 kW', '3,100 kW', '1,961 kW']);
      });

      it('still draws the charts when the stats fail to load', async () => {
        await start('/farms/FARM01/turbines/TURB001', history);
        // fakes() default: an empty window (null stats per metric) → no lines, no text
        expect(charts()).toHaveLength(5);
        expect(el().querySelector('[data-testid=stats]')).toBeNull();
        expect(markLines(0)).toEqual([]);

        api.telemetryStats.mockReturnValue(throwError(() => new Error('500')));
        el().querySelectorAll<HTMLButtonElement>('[data-testid=range] button')[0].click();
        await stable();

        expect(charts()).toHaveLength(5);
        expect(charts()[0].querySelector('[data-testid=latest]')?.textContent?.trim()).toBe(
          '1,961 kW',
        );
        expect(el().querySelector('[data-testid=stats]')).toBeNull();
        expect(el().querySelector('[role=alert]')).toBeNull(); // not an error worth a banner
      });
    });

    describe('time window (ends now)', () => {
      const HOUR = 3_600_000;
      const component = () =>
        fixture().debugElement.query((d) => d.name === 'app-line-chart')
          .componentInstance as LineChart;
      const xAxis = () =>
        (component().chart!.getOption()['xAxis'] as { min: number; max: number }[])[0];

      it('spans the whole range up to the current time, however sparse the data', async () => {
        await start('/farms/FARM01/turbines/TURB001', history);

        expect(xAxis()).toMatchObject({ min: CLOCK - 24 * HOUR, max: CLOCK });
        expect(text('[data-testid=window-end]')).toBe('Ending now (00:00 UTC)');
      });

      it('moves the time axis with the clock, without new readings', async () => {
        vi.useFakeTimers({ shouldAdvanceTime: true }); // timers only; the clock is NOW
        try {
          await start('/farms/FARM01/turbines/TURB001', history);
          clockNow = CLOCK + 60_000;
          await vi.advanceTimersByTimeAsync(60_000);
          await stable();

          expect(xAxis()).toMatchObject({ min: CLOCK + 60_000 - 24 * HOUR, max: CLOCK + 60_000 });
          expect(text('[data-testid=window-end]')).toBe('Ending now (00:01 UTC)');
          expect(api.telemetry).toHaveBeenCalledTimes(1); // no refetch per tick
        } finally {
          vi.useRealTimers();
        }
      });

      it('explains an empty window once, with the last reading, instead of empty charts', async () => {
        clockNow = Date.parse('2026-01-05T12:00:00.000Z'); // 2.5 days after the last reading
        await start('/farms/FARM01/turbines/TURB001');

        expect(charts()).toHaveLength(0);
        expect(el().querySelector('[data-testid=history]')).toBeNull();
        expect(text('[data-testid=empty-window-message]')).toBe(
          'No readings in the last 24 hours.',
        );
        expect(text('[data-testid=empty-window-last-reading]')).toBe(
          'Last reading: Jan 2, 2026, 23:55 UTC',
        );
        expect(el().querySelector('[data-testid=empty-window]')!.getAttribute('role')).toBe(
          'status',
        );
      });

      it('offers the shortest longer range that reaches the last reading', async () => {
        clockNow = Date.parse('2026-01-05T12:00:00.000Z');
        await start('/farms/FARM01/turbines/TURB001');

        const longer = el().querySelector<HTMLButtonElement>('[data-testid=empty-window-longer]')!;
        expect(longer.textContent?.trim()).toBe('Show the last 7 days');
        longer.click();
        await stable();

        expect(api.telemetry).toHaveBeenLastCalledWith(
          'TURB001',
          expect.objectContaining({ limit: 2016 }),
        );
        expect(
          el().querySelectorAll<HTMLButtonElement>('[data-testid=range] button')[3].ariaPressed,
        ).toBe('true');
      });

      it('names the selected range and offers nothing when even 7 days is too short', async () => {
        clockNow = Date.parse('2026-10-06T12:00:00.000Z');
        await start('/farms/FARM01/turbines/TURB001');
        el().querySelectorAll<HTMLButtonElement>('[data-testid=range] button')[0].click();
        await stable();

        expect(text('[data-testid=empty-window-message]')).toBe('No readings in the last 6 hours.');
        expect(el().querySelector('[data-testid=empty-window-longer]')).toBeNull();
      });

      it('says when a turbine has never reported', async () => {
        const farms = farmsFixture();
        farms[0].turbines[0].latest = null;
        await start('/farms/FARM01/turbines/TURB001', [], undefined, farms);

        expect(text('[data-testid=status]')).toBe('No readings yet');
        expect(staleness('[data-testid=status] [data-testid=staleness]')).toBe('empty');

        expect(text('[data-testid=empty-window-last-reading]')).toBe(
          'This turbine has not reported any readings yet.',
        );
      });

      it('replaces the empty state with charts when a live reading arrives', async () => {
        clockNow = Date.parse('2026-01-05T12:00:00.000Z');
        await start('/farms/FARM01/turbines/TURB001');

        sse.push(reading({ id: 'live', timestamp: '2026-01-05T12:00:00.000Z' }));
        await stable();

        expect(el().querySelector('[data-testid=empty-window]')).toBeNull();
        expect(charts()).toHaveLength(5);
        expect(el().querySelectorAll('[data-testid=history] tbody tr')).toHaveLength(1);
      });
    });

    it('lists the readings as a table, with late arrivals highlighted', async () => {
      await start('/farms/FARM01/turbines/TURB001', history);

      const delays = [...el().querySelectorAll('[data-testid=history] tbody td:nth-child(2)')];
      expect(delays.map((d) => d.textContent?.trim())).toEqual(['18 min', '2 min', '1 min']);
      expect(delays[0].hasAttribute('data-delayed')).toBe(true);
    });

    it('keeps the readings table in a keyboard-scrollable region capped at 500px', async () => {
      await start('/farms/FARM01/turbines/TURB001', history);

      const region = el().querySelector('[data-testid=history-scroll]')!;
      expect(region.getAttribute('role')).toBe('region');
      expect(region.getAttribute('tabindex')).toBe('0');
      expect(region.classList).toContain('max-h-[500px]');
      expect(region.classList).toContain('overflow-auto');
    });

    it('adds live readings to the charts and the table', async () => {
      await start('/farms/FARM01/turbines/TURB001', history);

      sse.push(reading({ id: 'live', timestamp: '2026-01-03T00:00:00.000Z', powerOutputKw: 3100 }));
      await stable();

      expect(charts()[0].querySelector('[data-testid=latest]')?.textContent?.trim()).toBe(
        '3,100 kW',
      );
      expect(el().querySelectorAll('[data-testid=history] tbody tr')).toHaveLength(4);
    });

    it('handles an unknown turbine, or a turbine on another farm', async () => {
      await start('/farms/FARM02/turbines/TURB001');
      expect(text('[data-testid=turbine-not-found]')).toBe(
        'Turbine TURB001 was not found on FARM02.',
      );
    });

    it('stops loading the turbine when leaving its page', async () => {
      await start('/farms/FARM01/turbines/TURB001', history);
      el().querySelectorAll<HTMLAnchorElement>('[data-testid=breadcrumb] a')[1].click();
      await stable();

      expect(text('h1')).toBe('Prairie Ridge FARM01');
      sse.push(reading({ id: 'after', timestamp: '2026-01-03T00:00:00.000Z' }));
      await stable();
      expect(el().querySelector('[data-testid=history]')).toBeNull();
    });
  });

  it('loads the fleet and opens the live connection once across navigation', async () => {
    await start('/');
    await harness.navigateByUrl('/farms/FARM01');
    await harness.navigateByUrl('/');
    await harness.navigateByUrl('/farms/FARM02');

    expect(api.farms).toHaveBeenCalledTimes(1);
    expect(sse.connect).toHaveBeenCalledTimes(1);
  });

  it('shows the live status in the shell on every page', async () => {
    await start('/farms/FARM01');
    expect(text('[data-testid=live-status]')).toBe('Connecting…');

    sse.status('open');
    await stable();
    expect(text('[data-testid=live-status]')).toBe('Live');
  });
});
