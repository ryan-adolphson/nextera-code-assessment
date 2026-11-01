import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { TestRequest } from '@angular/common/http/testing';
import { DeferBlockBehavior, DeferBlockState, TestBed } from '@angular/core/testing';
import { MatDateRangeInputHarness } from '@angular/material/datepicker/testing';
import { Title } from '@angular/platform-browser';
import { Router } from '@angular/router';
import { LineChart } from '../charts/line-chart';
import { TimeZoneSettings } from '../core/time-zone';
import { TEST_API_BASE_URL, openFleet, weatherResponse, weatherSlot } from '../fleet/testing';
import { WeatherSlot } from './weather.model';

/** 2026-01-03T00:00Z: Jan 3 in UTC, Jan 2, 18:00 in Chicago (the pinned browser zone). */
const CLOCK = Date.parse('2026-01-03T00:00:00.000Z');
const WEATHER_URL = (farmId: string) => `${TEST_API_BASE_URL}/farms/${farmId}/weather`;

/** Three buckets on Jan 2 with the 00:30 one missing (a gap), the last without humidity. */
const slots = (): WeatherSlot[] => [
  weatherSlot({ time: '2026-01-02T00:00:00.000Z', windSpeed80mMs: 8 }),
  weatherSlot({ time: '2026-01-02T01:00:00.000Z', windSpeed80mMs: 9 }),
  weatherSlot({
    time: '2026-01-02T01:30:00.000Z',
    windSpeed80mMs: 10,
    relativeHumidity2mPct: null,
  }),
];
const emptySlot = (time: string): WeatherSlot =>
  weatherSlot({
    time,
    samples: 0,
    windSpeed10mMs: null,
    windSpeed80mMs: null,
    windDirection10mDeg: null,
    windDirection80mDeg: null,
    windGusts10mMs: null,
    temperature2mC: null,
    relativeHumidity2mPct: null,
    surfacePressureHpa: null,
    precipitationMm: null,
    cloudCoverPct: null,
  });

describe('FarmWeatherHistoryPage (/farms/:farmId/weather)', () => {
  let app: Awaited<ReturnType<typeof openFleet>>;

  async function open(
    url = '/farms/FARM01/weather',
    timeZone: 'utc' | 'local' = 'utc',
    deferBlockBehavior = DeferBlockBehavior.Playthrough,
  ) {
    app = await openFleet(url, () => CLOCK, undefined, undefined, 'viewer', {
      timeZone,
      weatherHttp: true,
      deferBlockBehavior,
    });
  }
  afterEach(() => app.http.verify());

  const q = <T extends Element = HTMLElement>(id: string) =>
    app.root().querySelector<T>(`[data-testid=${id}]`);
  /** The pending 30-minute request (sent on the next change detection). */
  const expectWeather = (farmId = 'FARM01'): TestRequest => {
    TestBed.tick();
    return app.http.expectOne((r) => r.method === 'GET' && r.url === WEATHER_URL(farmId));
  };
  const range = (req: TestRequest) => [
    req.request.params.get('from'),
    req.request.params.get('to'),
  ];
  async function answer(req: TestRequest, points: WeatherSlot[]) {
    const p = req.request.params;
    req.flush(
      weatherResponse(
        req.request.url.split('/').at(-2)!,
        { from: p.get('from')!, to: p.get('to')!, interval: '30min' },
        points,
      ),
    );
    await app.stable();
  }
  /** Types days (en-US, M/D/YYYY) like a user; DOM events, since the harness would wait for the load. */
  function setDays(start: string | null, end: string | null) {
    const type = (testId: string, value: string) => {
      const input = q<HTMLInputElement>(testId)!;
      input.value = value;
      for (const event of ['input', 'change', 'blur']) input.dispatchEvent(new Event(event));
    };
    if (start !== null) type('weather-history-from', start);
    if (end !== null) type('weather-history-to', end);
    TestBed.tick();
  }
  const charts = () =>
    app.harness.fixture.debugElement
      .queryAll((d) => d.name === 'app-line-chart')
      .map((d) => d.componentInstance as LineChart);
  const picker = () =>
    TestbedHarnessEnvironment.loader(app.harness.fixture).getHarness(MatDateRangeInputHarness);

  it('asks for the last 7 UTC days in 30-minute buckets by default, with today as the latest day', async () => {
    await open();
    const req = expectWeather();
    expect(range(req)).toEqual(['2025-12-28T00:00:00.000Z', '2026-01-04T00:00:00.000Z']);
    expect(req.request.params.get('interval')).toBe('30min');
    expect(req.request.params.has('timeZone')).toBe(false);
    expect(req.request.headers.get('Authorization')).toBe('Bearer test-token-viewer');
    expect(app.text(q('weather-history-status'))).toBe('Loading weather…');
    await answer(req, slots());

    const range$ = await picker();
    expect(await range$.getValue()).toBe('12/28/2025 – 1/3/2026');
    expect(await (await range$.getEndInput()).getMax()).toBe('2026-01-03');
    expect(app.text(q('weather-history-range')!.querySelector('mat-label'))).toBe('Dates (UTC)');
    expect(app.text(q('weather-history-status'))).toBe('3 of 336 half-hours synced');
    expect(TestBed.inject(Title).getTitle()).toBe('Prairie Ridge · Weather history · Nextera');
    expect(app.text(app.root().querySelector('h1'))).toBe('Prairie Ridge FARM01');
  });

  it('draws one line chart per weather metric over the chosen days, with gaps for missing buckets', async () => {
    await open();
    await answer(expectWeather(), slots());

    const group = q('weather-history-charts')!;
    expect(group.getAttribute('aria-label')).toBe('Weather charts');
    expect(
      [...group.querySelectorAll('app-line-chart')].map((c) => c.getAttribute('data-metric')),
    ).toEqual([
      'wind-80m',
      'wind-10m',
      'gusts',
      'temperature',
      'precipitation',
      'humidity',
      'pressure',
      'cloud-cover',
    ]);
    const all = charts();
    expect(all.map((c) => [c.title(), c.unit(), c.kind()])).toEqual([
      ['Wind speed, 80 m (mean)', 'm/s', 'line'],
      ['Wind speed, 10 m', 'm/s', 'line'],
      ['Wind gusts, 10 m', 'm/s', 'line'],
      ['Temperature, 2 m', '°C', 'line'],
      ['Precipitation per 30 min', 'mm', 'line'],
      ['Relative humidity, 2 m', '%', 'line'],
      ['Surface pressure', 'hPa', 'line'],
      ['Cloud cover', '%', 'line'],
    ]);
    const wind = all[0];
    expect(wind.domain()).toEqual({
      from: Date.parse('2025-12-28T00:00:00.000Z'),
      to: Date.parse('2026-01-04T00:00:00.000Z'),
    });
    // 00:00, a break for the missing 00:30 bucket, then 01:00 and 01:30 joined.
    const series = (wind.chart!.getOption()['series'] as { data: unknown[] }[])[0];
    const values = series.data.map((d) =>
      Array.isArray(d) ? d[1] : (d as { value: [number, number | null] }).value[1],
    );
    expect(values).toEqual([8, null, 9, 10]);
    // A null value is left out: humidity has two points.
    expect(all[5].points().map((p) => p.v)).toEqual([80, 80]);
    // The plot's summary names the latest value and time in the zone shown.
    const plot = app.root().querySelector('app-line-chart [role=img]')!;
    expect(plot.getAttribute('aria-label')).toBe(
      'Wind speed, 80 m (mean): latest 10.0 m/s at Jan 2, 01:30 UTC. 3 readings.',
    );
  });

  it('loads again when the range changes, and explains an invalid range without asking the API', async () => {
    await open();
    await answer(expectWeather(), slots());

    setDays('1/1/2026', null);
    const req = expectWeather();
    expect(range(req)).toEqual(['2026-01-01T00:00:00.000Z', '2026-01-04T00:00:00.000Z']);
    await answer(req, slots());
    expect(app.text(q('weather-history-status'))).toBe('3 of 144 half-hours synced');

    setDays('1/5/2026', '1/3/2026');
    TestBed.tick();
    app.http.expectNone(WEATHER_URL('FARM01'));
    expect(app.text(q('weather-history-range-error'))).toBe(
      'The end date must not be before the start date.',
    );
    expect(q('weather-history-charts')).not.toBeNull(); // the last charts stay

    setDays('12/1/2025', '1/3/2026');
    TestBed.tick();
    app.http.expectNone(WEATHER_URL('FARM01'));
    expect(app.text(q('weather-history-range-error'))).toBe('Choose at most 31 days.');
  });

  it('says when no weather was synced for the days (no buckets, or only empty ones)', async () => {
    await open();
    await answer(expectWeather(), []);
    expect(app.text(q('weather-history-empty'))).toBe('No weather synced for these days.');
    expect(q('weather-history-charts')).toBeNull();
    expect(app.text(q('weather-history-status'))).toBe('0 of 336 half-hours synced');

    setDays('1/2/2026', null);
    await answer(expectWeather(), [emptySlot('2026-01-02T00:00:00.000Z')]);
    expect(q('weather-history-empty')).not.toBeNull();
    expect(q('weather-history-charts')).toBeNull();
  });

  it('shows a load error with a Retry that sends the request again', async () => {
    await open();
    expectWeather().flush('boom', { status: 500, statusText: 'Server Error' });
    await app.stable();
    expect(app.text(q('weather-history-error'))).toContain('The weather could not be loaded.');
    expect(q('weather-history-empty')).toBeNull();
    expect(app.text(q('weather-history-status'))).toBe('');

    q<HTMLButtonElement>('weather-history-retry')!.click();
    const req = expectWeather();
    expect(range(req)).toEqual(['2025-12-28T00:00:00.000Z', '2026-01-04T00:00:00.000Z']);
    await answer(req, slots());
    expect(q('weather-history-error')).toBeNull();
    expect(q('weather-history-charts')).not.toBeNull();
  });

  it('asks for local days in local mode, and refuses 31 days across the autumn clock change', async () => {
    await open('/farms/FARM01/weather', 'local');
    // Jan 2, 18:00 CST: the last 7 days are Dec 27 – Jan 2, local midnights.
    const req = expectWeather();
    expect(range(req)).toEqual(['2025-12-27T06:00:00.000Z', '2026-01-03T06:00:00.000Z']);
    await answer(req, slots());
    expect(await (await picker()).getValue()).toBe('12/27/2025 – 1/2/2026');
    expect(await (await (await picker()).getEndInput()).getMax()).toBe('2026-01-02');
    expect(app.text(q('weather-history-range')!.querySelector('mat-label'))).toBe('Dates (local)');
    expect(app.root().querySelector('app-line-chart [role=img]')!.getAttribute('aria-label')).toBe(
      'Wind speed, 80 m (mean): latest 10.0 m/s at Jan 1, 19:30 CST. 3 readings.',
    );

    // Oct 15 – Nov 14, 2025 gains an hour on Nov 2: 31 days are 31 × 24 h + 1 h.
    setDays('10/15/2025', '11/14/2025');
    TestBed.tick();
    app.http.expectNone(WEATHER_URL('FARM01'));
    expect(app.text(q('weather-history-range-error'))).toBe(
      'Choose at most 30 days when the range includes a daylight-saving change.',
    );
  });

  it('keeps the picked calendar days and queries them again when the zone changes', async () => {
    await open('/farms/FARM01/weather', 'local');
    await answer(expectWeather(), []);

    TestBed.inject(TimeZoneSettings).setMode('utc');
    const req = expectWeather();
    expect(range(req)).toEqual(['2025-12-27T00:00:00.000Z', '2026-01-03T00:00:00.000Z']);
    await answer(req, slots());
    expect(await (await picker()).getValue()).toBe('12/27/2025 – 1/2/2026');
    expect(app.text(q('weather-history-range')!.querySelector('mat-label'))).toBe('Dates (UTC)');
  });

  it("queries another farm's weather when the farm changes, without showing the last farm's", async () => {
    await open();
    await answer(expectWeather(), slots());

    await TestBed.inject(Router).navigateByUrl('/farms/FARM02/weather');
    const req = expectWeather('FARM02');
    expect(q('weather-history-charts')).toBeNull(); // FARM01's charts are gone
    expect(app.text(app.root().querySelector('h1'))).toBe('High Plains FARM02');
    await answer(req, slots());
    expect(q('weather-history-charts')).not.toBeNull();
    expect(TestBed.inject(Title).getTitle()).toBe('High Plains · Weather history · Nextera');
  });

  it('says an unknown farm was not found, without asking for weather', async () => {
    await open('/farms/FARM99/weather');
    TestBed.tick();
    app.http.expectNone(WEATHER_URL('FARM99'));
    expect(app.text(q('farm-not-found'))).toBe('Farm FARM99 was not found.');
    expect(q('farm-tabs')).toBeNull();
    expect(TestBed.inject(Title).getTitle()).toBe('FARM99 · Weather history · Nextera');
  });

  describe('deferred charts (@defer)', () => {
    async function openManual() {
      await open('/farms/FARM01/weather', 'utc', DeferBlockBehavior.Manual);
      await answer(expectWeather(), slots());
    }
    const block = async () => (await app.harness.fixture.getDeferBlocks())[0];

    it('keeps the charts’ size with a skeleton card per chart until ECharts loads', async () => {
      await openManual();
      expect(q('weather-history-charts')).toBeNull();
      const cards = [...app.root().querySelectorAll('[data-testid=chart-skeleton-card]')];
      expect(cards.map((c) => app.text(c))).toEqual([
        'Wind speed, 80 m (mean)',
        'Wind speed, 10 m',
        'Wind gusts, 10 m',
        'Temperature, 2 m',
        'Precipitation per 30 min',
        'Relative humidity, 2 m',
        'Surface pressure',
        'Cloud cover',
      ]);

      await (await block()).render(DeferBlockState.Loading);
      await app.stable();
      expect(app.text(q('charts-loading'))).toBe('Loading charts…');

      await (await block()).render(DeferBlockState.Complete);
      await app.stable();
      expect(q('weather-history-charts')).not.toBeNull();
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
