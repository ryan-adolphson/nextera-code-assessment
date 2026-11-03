import { TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { TimeZoneSettings } from '../core/time-zone';
import {
  TEST_API_BASE_URL,
  openFleet,
  reading,
  weatherDay,
  weatherResponse,
  weatherSlot,
} from '../fleet/testing';
import { WeatherDay, WeatherSlot } from './weather.model';

/**
 * The farm page's Weather section: GET /api/farms/:farmId/weather twice, the last 24 h of
 * 30-minute buckets (latest tiles) and the last 7 days (daily, `timeZone` = the zone shown).
 * /farms/FARM01 at client time 2026-01-03T00:00Z (Jan 2, 18:00 in Chicago).
 */
describe('FarmWeather (/farms/:farmId)', () => {
  const CLOCK = Date.parse('2026-01-03T00:00:00.000Z');
  const WEATHER_URL = `${TEST_API_BASE_URL}/farms/FARM01/weather`;
  let app: Awaited<ReturnType<typeof openFleet>>;

  async function open(timeZone: 'utc' | 'local' = 'utc') {
    app = await openFleet('/farms/FARM01', () => CLOCK, undefined, undefined, 'viewer', {
      timeZone,
      weatherHttp: true,
    });
  }
  afterEach(() => app.http.verify());

  const pending = (interval: '30min' | 'daily'): TestRequest =>
    app.http.expectOne(
      (r) => r.url === WEATHER_URL && r.params.get('interval') === interval,
      `${interval} weather`,
    );
  /** Both requests (sent on the next change detection), answered. */
  async function answer(slots: WeatherSlot[], days: WeatherDay[]) {
    TestBed.tick();
    flush(pending('30min'), slots);
    flush(pending('daily'), days);
    await app.stable();
  }
  function flush(req: TestRequest, points: WeatherSlot[] | WeatherDay[]) {
    const p = req.request.params;
    req.flush(
      weatherResponse(
        'FARM01',
        {
          from: p.get('from')!,
          to: p.get('to')!,
          interval: p.get('interval') as '30min',
          timeZone: p.get('timeZone') ?? undefined,
        },
        points as WeatherSlot[],
      ),
    );
  }
  const q = (testId: string) => app.root().querySelector<HTMLElement>(`[data-testid=${testId}]`);
  const tile = (testId: string) => app.text(q(testId));
  const rows = () =>
    [...app.root().querySelectorAll('[data-testid=weather-day]')].map((row) =>
      [...row.querySelectorAll('td')].map((td) => app.text(td)),
    );

  const slots = () => [
    weatherSlot({ time: '2026-01-02T23:00:00.000Z', windSpeed80mMs: 8 }),
    weatherSlot({ time: '2026-01-02T23:30:00.000Z' }), // the latest that has started
    weatherSlot({ time: '2026-01-03T00:30:00.000Z', windSpeed80mMs: 20 }), // not yet
  ];
  const days = () => [
    weatherDay({ date: '2026-01-02' }),
    weatherDay({
      date: '2026-01-03',
      samples: 1,
      temperature2mMinC: -1.5,
      temperature2mMaxC: -1.5,
      windSpeed80mMeanMs: null,
    }),
  ];

  it('requests the last 24 h of 30-minute buckets and the last 7 UTC days', async () => {
    await open();
    TestBed.tick();
    const recent = pending('30min');
    expect(recent.request.params.get('from')).toBe('2026-01-02T00:00:00.000Z');
    expect(recent.request.params.get('to')).toBe('2026-01-03T00:30:00.000Z');
    expect(recent.request.params.has('timeZone')).toBe(false);
    const daily = pending('daily');
    expect(daily.request.params.get('from')).toBe('2025-12-28T00:00:00.000Z');
    expect(daily.request.params.get('to')).toBe('2026-01-04T00:00:00.000Z');
    expect(daily.request.params.get('timeZone')).toBe('UTC');
    expect(daily.request.headers.get('Authorization')).toBe('Bearer test-token-viewer');
    expect(app.text(q('weather-loading'))).toBe('Loading weather…');
    flush(recent, []);
    flush(daily, []);
    await app.stable();
  });

  it('asks for local calendar days in local mode', async () => {
    await open('local');
    TestBed.tick();
    const daily = pending('daily');
    expect(daily.request.params.get('timeZone')).toBe('America/Chicago');
    expect(daily.request.params.get('from')).toBe('2025-12-27T06:00:00.000Z'); // Dec 27, 00:00 CST
    expect(daily.request.params.get('to')).toBe('2026-01-03T06:00:00.000Z'); // after Jan 2
    flush(daily, []);
    flush(pending('30min'), []);
    await app.stable();
    expect(app.text(q('farm-weather'))).toContain('Days are in local time (America/Chicago).');
  });

  it('shows tiles for the latest bucket and today, and a daily table', async () => {
    await open();
    await answer(slots(), days());

    expect(app.text(q('weather-latest-time'))).toBe('Latest 30 minutes from Jan 2, 23:30 UTC');
    expect(tile('weather-wind')).toBe('9.4 m/s');
    expect(tile('weather-gusts')).toBe('12.5 m/s');
    expect(tile('weather-temperature')).toBe('-1.5 °C');
    expect(tile('weather-precipitation')).toBe('0.2 mm');
    expect(tile('weather-today-temp')).toBe('-1.5 / -1.5 °C');

    expect([...q('weather-daily')!.querySelectorAll('thead th')].map((th) => app.text(th))).toEqual(
      [
        'Day (UTC)',
        'Wind 80 m, mean (m/s)',
        'Wind 80 m, max (m/s)',
        'Temp. min (°C)',
        'Temp. max (°C)',
        'Precipitation (mm)',
        'Coverage',
      ],
    );
    expect(rows()).toEqual([
      ['Fri, Jan 2', '8.3', '13.1', '-4.2', '3.6', '1.4', '48 / 48'],
      ['Sat, Jan 3 (today)', '–', '13.1', '-1.5', '-1.5', '1.4', '1 / 48'],
    ]);
    const coverage = [...app.root().querySelectorAll('[data-testid=weather-day] td:last-child')];
    expect(coverage.map((td) => td.hasAttribute('data-partial'))).toEqual([false, true]);
  });

  it('shows "–" for missing values and for a day without today', async () => {
    await open();
    await answer(
      [
        weatherSlot({
          windSpeed80mMs: null,
          windGusts10mMs: null,
          temperature2mC: null,
          precipitationMm: null,
        }),
      ],
      [weatherDay({ date: '2026-01-02' })],
    );
    for (const id of ['weather-wind', 'weather-gusts', 'weather-temperature']) {
      expect(tile(id)).toBe('–');
    }
    expect(tile('weather-precipitation')).toBe('–');
    expect(tile('weather-today-temp')).toBe('–');
  });

  it('says so when no weather is synced', async () => {
    await open();
    await answer([], []);
    expect(app.text(q('weather-latest-empty'))).toBe('No weather synced for this period.');
    expect(app.text(q('weather-daily-empty'))).toBe('No weather synced for this period.');
    expect(q('weather-daily')).toBeNull();
  });

  it('reloads the days (not the buckets) when the time-zone setting changes', async () => {
    await open();
    await answer(slots(), days());

    TestBed.inject(TimeZoneSettings).setMode('local');
    TestBed.tick();
    const daily = pending('daily');
    expect(daily.request.params.get('timeZone')).toBe('America/Chicago');
    app.http.expectNone((r) => r.params.get('interval') === '30min');
    // Until the local days arrive, the UTC ones are not shown as if they were local.
    expect(app.text(q('weather-loading'))).toBe('Loading weather…');
    flush(daily, [weatherDay({ date: '2026-01-02' })]);
    await app.stable();
    expect(rows()[0][0]).toBe('Fri, Jan 2 (today)');
    expect([...q('weather-daily')!.querySelectorAll('thead th')].map((th) => app.text(th))[0]).toBe(
      'Day (local)',
    );
  });

  it('never refetches on live readings', async () => {
    await open();
    await answer(slots(), days());
    app.sse.push(reading({ id: 'live', timestamp: '2026-01-03T00:00:00.000Z' }));
    await app.stable();
    TestBed.tick();
    app.http.expectNone(WEATHER_URL);
  });

  it('shows an error with Retry (only the failed request again), and keeps the rest of the page', async () => {
    await open();
    TestBed.tick();
    flush(pending('30min'), slots());
    pending('daily').flush('boom', { status: 500, statusText: 'Server Error' });
    await app.stable();

    expect(app.text(q('weather-error'))).toContain('Weather is unavailable right now.');
    expect(q('turbines')).not.toBeNull(); // the farm's turbines table
    expect(q('farm-power')).not.toBeNull();

    q('weather-retry')!.click();
    TestBed.tick();
    app.http.expectNone((r) => r.params.get('interval') === '30min');
    flush(pending('daily'), days());
    await app.stable();
    expect(q('weather-error')).toBeNull();
    expect(rows()).toHaveLength(2);
  });

  it('retries a failed 30-minute request', async () => {
    await open();
    TestBed.tick();
    pending('30min').flush('boom', { status: 503, statusText: 'Unavailable' });
    flush(pending('daily'), days());
    await app.stable();
    q('weather-retry')!.click();
    TestBed.tick();
    flush(pending('30min'), slots());
    await app.stable();
    expect(tile('weather-wind')).toBe('9.4 m/s');
  });
});
