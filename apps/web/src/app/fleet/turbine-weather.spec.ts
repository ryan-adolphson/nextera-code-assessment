import { TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { Subject, of } from 'rxjs';
import { LineChart } from '../charts/line-chart';
import { WeatherSlot } from '../weather/weather.model';
import {
  TEST_API_BASE_URL,
  openFleet,
  reading,
  renderDeferred,
  weatherResponse,
  weatherSlot,
} from './testing';

/**
 * The turbine page's weather (GET /api/turbines/:id/weather?interval=30min for the page's window):
 * the farm's 80 m wind over the wind chart, temperature/gusts/precipitation charts on the shared
 * axis, and the loading, empty and error states, which never affect the telemetry.
 * TURB001 (FARM01, Prairie Ridge) at client time 2026-01-03T00:00Z, readings 23:00–23:55.
 */
describe('TurbinePage weather (/farms/:farmId/turbines/:turbineId)', () => {
  const CLOCK = Date.parse('2026-01-03T00:00:00.000Z');
  const URL = '/farms/FARM01/turbines/TURB001';
  const WEATHER_URL = `${TEST_API_BASE_URL}/turbines/TURB001/weather`;
  const MINUTE = 60_000;
  let clockNow: number;
  let app: Awaited<ReturnType<typeof openFleet>>;

  const history = Array.from({ length: 12 }, (_, i) =>
    reading({
      id: `r${i}`,
      timestamp: new Date(Date.parse('2026-01-02T23:55:00Z') - i * 5 * MINUTE).toISOString(),
      windSpeedMs: 7 + i / 10,
    }),
  );
  /** Weather every 30 minutes from 22:00 to 00:00 (the last one is a later, partial bucket). */
  const slots = (): WeatherSlot[] =>
    ['22:00', '22:30', '23:00', '23:30'].map((hm, i) =>
      weatherSlot({ time: `2026-01-02T${hm}:00.000Z`, windSpeed80mMs: 9 + i, temperature2mC: -i }),
    );

  async function open(url = URL, readings = history) {
    clockNow = CLOCK;
    app = await openFleet(
      url,
      () => clockNow,
      undefined,
      ({ api }) => api.telemetry.mockReturnValue(of(readings)),
      'viewer',
      { weatherHttp: true },
    );
    // The deferred chart group (with the weather status): not `stable()`, since the weather
    // request is pending until the test answers it.
    await renderDeferred(app.harness.fixture);
  }
  afterEach(() => app.http.verify());

  /** The pending weather request (the resource sends it on the next change detection). */
  function weatherRequest(): TestRequest {
    TestBed.tick();
    return app.http.expectOne((r) => r.method === 'GET' && r.url === WEATHER_URL);
  }
  async function answer(points: WeatherSlot[]) {
    const req = weatherRequest();
    req.flush(
      weatherResponse(
        'FARM01',
        {
          from: req.request.params.get('from')!,
          to: req.request.params.get('to')!,
          interval: '30min',
        },
        points,
        'TURB001',
      ),
    );
    await app.stable();
  }
  const q = (testId: string) => app.root().querySelector<HTMLElement>(`[data-testid=${testId}]`);
  const charts = () =>
    app.harness.fixture.debugElement
      .queryAll(By.directive(LineChart))
      .map((d) => d.componentInstance as LineChart);
  const chart = (metric: string) =>
    app.harness.fixture.debugElement.query(By.css(`app-line-chart[data-metric=${metric}]`))
      ?.componentInstance as LineChart | undefined;
  const metrics = () =>
    [...app.root().querySelectorAll('app-line-chart')].map((c) => c.getAttribute('data-metric'));
  const TELEMETRY = ['powerOutputKw', 'windSpeedMs', 'rotorRpm', 'bladePitchDeg', 'gearboxTempC'];
  const readingRows = () => app.root().querySelectorAll('[data-testid=history] tbody tr').length;

  it("requests the turbine's 30-minute weather for the window, in whole buckets, without a zone", async () => {
    await open();
    const req = weatherRequest();
    expect(req.request.params.keys().sort()).toEqual(['from', 'interval', 'to']);
    expect(req.request.params.get('from')).toBe('2026-01-02T00:00:00.000Z'); // now − 24 h
    expect(req.request.params.get('to')).toBe('2026-01-03T00:30:00.000Z'); // end of now's bucket
    expect(req.request.params.get('interval')).toBe('30min');
    expect(req.request.headers.get('Authorization')).toBe('Bearer test-token-viewer');
    expect(app.text(q('weather-loading'))).toBe('Loading weather…');
    req.flush(weatherResponse('FARM01', { from: '', to: '', interval: '30min' }, slots()));
    await app.stable();
  });

  it('overlays the 80 m wind on the wind chart, with a legend, tooltip line and aria-label', async () => {
    await open();
    await answer(slots());

    const wind = chart('windSpeedMs')!;
    expect(wind.overlay()?.label).toBe('Open-Meteo 80 m (farm)');
    expect(wind.overlay()?.points.map((p) => p.v)).toEqual([9, 10, 11, 12]);
    // Only the wind chart has it.
    expect(chart('powerOutputKw')!.overlay()).toBeNull();
    const figure = app.root().querySelector('app-line-chart[data-metric=windSpeedMs]')!;
    expect(app.text(figure.querySelector('[data-testid=overlay-legend]'))).toBe(
      'Open-Meteo 80 m (farm)',
    );
    expect(figure.querySelector('[role=img]')!.getAttribute('aria-label')).toContain(
      'Open-Meteo 80 m (farm): latest 12.0 m/s at Jan 2, 23:30 UTC.',
    );
  });

  it('adds temperature, gusts and precipitation charts on the shared axis, under a heading', async () => {
    await open();
    await answer(slots());

    expect(metrics()).toEqual([
      ...TELEMETRY,
      'alerts',
      'weather-temperature',
      'weather-gusts',
      'weather-precipitation',
    ]);
    expect(app.text(q('weather-heading'))).toBe('Weather at Prairie Ridge');
    expect(app.text(q('weather-note'))).toContain('per 30 minutes');
    expect(q('weather')!.getAttribute('data-state')).toBe('ok');
    expect(
      chart('weather-temperature')!
        .points()
        .map((p) => p.v),
    ).toEqual([-0, -1, -2, -3]);
    expect(chart('weather-precipitation')!.title()).toBe('Precipitation per 30 min (Open-Meteo)');
    // One crosshair: hovering a weather chart moves every chart's, the telemetry's too.
    chart('weather-temperature')!.hoverAt(Date.parse('2026-01-02T23:31:00Z')); // snaps to 23:30
    await app.stable();
    expect(chart('weather-gusts')!.hoverT()).toBe(Date.parse('2026-01-02T23:30:00Z'));
    expect(chart('windSpeedMs')!.hoverT()).toBe(Date.parse('2026-01-02T23:30:00Z'));
  });

  it('says so when no weather is synced for the window, and keeps the telemetry', async () => {
    await open();
    // A bucket before the window only.
    await answer([weatherSlot({ time: '2026-01-01T12:00:00.000Z' })]);

    expect(app.text(q('weather-empty'))).toBe('No weather synced for this period.');
    expect(q('weather-empty')!.getAttribute('role')).toBe('status');
    expect(metrics()).toEqual([...TELEMETRY, 'alerts']);
    expect(chart('windSpeedMs')!.overlay()).toBeNull();
  });

  it('shows an error with Retry and leaves the telemetry charts and readings intact', async () => {
    await open();
    weatherRequest().flush('boom', { status: 500, statusText: 'Server Error' });
    await app.stable();

    expect(app.text(q('weather-error'))).toContain('Weather is unavailable right now');
    expect(metrics()).toEqual([...TELEMETRY, 'alerts']);
    expect(charts()[0].points()).toHaveLength(12);
    expect(readingRows()).toBe(12);

    q('weather-retry')!.click();
    await answer(slots());
    expect(q('weather-error')).toBeNull();
    expect(metrics()).toContain('weather-temperature');
  });

  it('never refetches on live readings, only for another range', async () => {
    await open();
    await answer(slots());

    app.sse.push(reading({ id: 'live', timestamp: '2026-01-03T00:00:00.000Z' }));
    await app.stable();
    TestBed.tick();
    app.http.expectNone(WEATHER_URL);

    // 6h (no whenStable: it would wait for the weather request, which is flushed below)
    app.root().querySelectorAll<HTMLButtonElement>('[data-testid=range] button')[0].click();
    const req = weatherRequest();
    expect(req.request.params.get('from')).toBe('2026-01-02T18:00:00.000Z');
    req.flush(weatherResponse('FARM01', { from: '', to: '', interval: '30min' }, slots()));
    await app.stable();
  });

  it('refetches when the sliding window enters a new 30-minute bucket, not on every clock tick', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await open();
      await answer(slots());

      clockNow += 20 * MINUTE; // 00:20: same buckets
      await vi.advanceTimersByTimeAsync(20 * MINUTE);
      await app.stable();
      TestBed.tick();
      app.http.expectNone(WEATHER_URL);

      clockNow += 11 * MINUTE; // 00:31: the window slid into the next bucket
      await vi.advanceTimersByTimeAsync(11 * MINUTE);
      const req = weatherRequest();
      expect(req.request.params.get('from')).toBe('2026-01-02T00:30:00.000Z');
      expect(req.request.params.get('to')).toBe('2026-01-03T01:00:00.000Z');
      req.flush(weatherResponse('FARM01', { from: '', to: '', interval: '30min' }, slots()));
      await app.stable();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows no weather and requests none when the window has no readings', async () => {
    await open(URL, []);
    TestBed.tick();
    app.http.expectNone(WEATHER_URL);

    expect(q('empty-window')).not.toBeNull();
    expect(q('weather')).toBeNull();
    expect(q('weather-heading')).toBeNull();
    expect(q('weather-loading')).toBeNull();
    expect(metrics()).toEqual([]);
  });

  it('requests the weather once a live reading lands in an empty window, and shows it', async () => {
    await open(URL, []);
    // No whenStable here: it would wait for the weather request, which is flushed below.
    app.sse.push(reading({ id: 'live', timestamp: '2026-01-03T00:00:00.000Z' }));

    const req = weatherRequest();
    expect(req.request.params.get('from')).toBe('2026-01-02T00:00:00.000Z');
    app.harness.fixture.detectChanges();
    expect(app.text(q('weather-loading'))).toBe('Loading weather…');
    req.flush(weatherResponse('FARM01', { from: '', to: '', interval: '30min' }, slots()));
    await app.stable();

    expect(q('empty-window')).toBeNull();
    expect(metrics()).toEqual([
      ...TELEMETRY,
      'alerts',
      'weather-temperature',
      'weather-gusts',
      'weather-precipitation',
    ]);
    expect(chart('windSpeedMs')!.overlay()?.points).toHaveLength(4);
  });

  it('requests the weather when a longer range brings readings into the window', async () => {
    await open(URL, []);
    TestBed.tick();
    app.http.expectNone(WEATHER_URL);

    // 7d now finds readings (from an earlier day).
    app.api.telemetry.mockReturnValue(of(history));
    app.root().querySelectorAll<HTMLButtonElement>('[data-testid=range] button')[3].click();
    const req = weatherRequest();
    expect(req.request.params.get('from')).toBe('2025-12-27T00:00:00.000Z');
    req.flush(weatherResponse('FARM01', { from: '', to: '', interval: '30min' }, slots()));
    await app.stable();
    expect(metrics()).toContain('weather-temperature');
  });

  it('waits for the history before requesting the weather (nothing sent, then cancelled)', async () => {
    const pending = new Subject<ReturnType<typeof reading>[]>();
    clockNow = CLOCK;
    app = await openFleet(
      URL,
      () => clockNow,
      undefined,
      ({ api }) => api.telemetry.mockReturnValue(pending),
      'viewer',
      { weatherHttp: true },
    );
    TestBed.tick();
    app.http.expectNone(WEATHER_URL);
    expect(q('weather')).toBeNull();

    pending.next(history);
    pending.complete();
    await answer(slots());
    expect(q('weather')!.getAttribute('data-state')).toBe('ok');
  });

  it('does not resend the same request when the window empties and a reading lands again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // One reading at the 24 h window's start: it leaves the window within the same buckets.
      const edge = reading({ id: 'edge', timestamp: '2026-01-02T00:00:00.000Z' });
      await open(URL, [edge]);
      await answer(slots());

      clockNow += 10 * MINUTE; // 00:10: the reading left the window, same 30-minute buckets
      await vi.advanceTimersByTimeAsync(10 * MINUTE);
      await app.stable();
      expect(q('empty-window')).not.toBeNull();
      expect(q('weather')).toBeNull();

      app.sse.push(reading({ id: 'live', timestamp: '2026-01-03T00:10:00.000Z' }));
      await app.stable();
      TestBed.tick();
      app.http.expectNone(WEATHER_URL);
      expect(q('weather')!.getAttribute('data-state')).toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });

  it('requests nothing for a turbine that is not in the fleet', async () => {
    await open('/farms/FARM01/turbines/TURB999');
    TestBed.tick();
    app.http.expectNone(WEATHER_URL);
    expect(q('turbine-not-found')).not.toBeNull();
  });
});
