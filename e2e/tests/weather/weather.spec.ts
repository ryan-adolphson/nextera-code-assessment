import { expect, test, type Page, type Request, type Response } from '@playwright/test';
import { fixBrowserDate } from '../support/clock.js';
import { SEED_NOW, logIn, signIn } from '../support/session.js';
import { boundTelemetryAt } from '../support/telemetry.js';
import {
  isWeatherRequest,
  mockWeather,
  oneDecimal,
  slotAt,
  weatherQuery,
  type WeatherDay,
  type WeatherSlot,
} from '../support/weather.js';

// Plan 13: Open-Meteo weather on the farm page and the turbine page. Read-only.
//
// The db:seed fixture has no weather (the sync only fetches recent days), so the populated views
// use page.route mocks in the API's shape (support/weather.ts), built from each request's own
// from/to/timeZone. One test per page goes to the real API: at the fixture's date it shows the
// empty state (or the data, if this DB happens to have weather for those days).
//
// The clock is fixed at SEED_NOW (2026-01-03T00:00Z): the turbine page's default 24 h window is
// Jan 2, the farm's 7 days end on Jan 3 (UTC). The live stream is cut (abort) so no reading from
// the demo feed or another test changes the page mid-test, and the turbine's history requests are
// bounded at SEED_NOW (boundTelemetryAt) so a DB that also holds later demo readings still shows
// the fixture's Jan 2 (TURB001: 288 readings).

const FARM = 'FARM01';
const FARM_NAME = 'Prairie Ridge';
const TURBINE = 'TURB001';
const TURBINE_URL = `/farms/${FARM}/turbines/${TURBINE}`;
const FARM_URL = `/farms/${FARM}`;
const NOW_MS = SEED_NOW.getTime();
const OVERLAY = 'Open-Meteo 80 m (farm)';
const WEATHER_METRICS = ['weather-temperature', 'weather-gusts', 'weather-precipitation'] as const;

const chart = (page: Page, metric: string) => page.locator(`app-line-chart[data-metric="${metric}"]`);
const weather = (page: Page) => page.getByTestId('weather');
const farmWeather = (page: Page) => page.getByTestId('farm-weather');
const readingRows = (page: Page) => page.getByTestId('history').getByRole('row');

/** The next weather request of `interval` (sent by the page). */
const weatherRequest = (page: Page, interval: '30min' | 'daily') =>
  page.waitForRequest((r) => isWeatherRequest(r, interval));
const weatherResponse = (page: Page, interval: '30min' | 'daily') =>
  page.waitForResponse((r) => isWeatherRequest(r.request(), interval));

/** A UTC browser at SEED_NOW, no live stream, signed in as admin. */
async function open(page: Page): Promise<void> {
  await page.route('**/api/events**', (route) => route.abort());
  await boundTelemetryAt(page, SEED_NOW);
  await signIn(page, 'admin');
}

/** Opens TURBINE's page and waits until its telemetry is drawn (the readings table has rows). */
async function openTurbine(page: Page): Promise<void> {
  await page.goto(TURBINE_URL);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(TURBINE);
  await expect(readingRows(page).nth(1)).toBeVisible();
}

test.describe('Weather on the turbine page', () => {
  test('draws the farm 80 m wind over the wind chart and adds temperature, gusts and precipitation charts', async ({
    page,
  }) => {
    await open(page);
    const seen = await mockWeather(page);
    const request = weatherRequest(page, '30min');
    await openTurbine(page);

    // One request for the 24 h window in whole 30-minute buckets; no time zone for 30min.
    const query = weatherQuery(await request);
    expect(query).toEqual({
      from: '2026-01-02T00:00:00.000Z',
      to: '2026-01-03T00:30:00.000Z',
      interval: '30min',
      timeZone: null,
    });
    expect(new URL((await request).url()).pathname).toMatch(
      new RegExp(`/api/turbines/${TURBINE}/weather$`),
    );

    await expect(weather(page)).toHaveAttribute('data-state', 'ok');
    await expect(page.getByTestId('weather-heading')).toHaveText(`Weather at ${FARM_NAME}`);
    await expect(page.getByTestId('weather-note')).toContainText(
      "The wind chart compares it at 80 m with the turbine's measured wind.",
    );
    await expect(page.getByTestId('weather-loading')).toHaveCount(0);
    await expect(page.getByTestId('weather-empty')).toHaveCount(0);
    await expect(page.getByTestId('weather-error')).toHaveCount(0);

    // The measured wind chart names both lines and summarises the overlay's latest value.
    const wind = chart(page, 'windSpeedMs');
    await expect(wind.getByTestId('series-legend')).toContainText('Turbine (measured)');
    await expect(wind.getByTestId('overlay-legend')).toHaveText(OVERLAY);
    const latest = slotAt(NOW_MS); // the bucket starting at the window's end (00:00) is the last
    // The chart's text alternative (role img) names the overlay's latest value.
    await expect(
      wind.getByRole('img', {
        name: `${OVERLAY}: latest ${oneDecimal(latest.windSpeed80mMs!)} m/s at`,
      }),
    ).toBeVisible();
    // Only the wind chart has the overlay.
    await expect(chart(page, 'powerOutputKw').getByTestId('overlay-legend')).toHaveCount(0);

    // The three weather charts, drawn (SVG) with the window's latest bucket as their label.
    const expected: Record<(typeof WEATHER_METRICS)[number], [string, string]> = {
      'weather-temperature': ['Temperature, 2 m (Open-Meteo)', `${oneDecimal(latest.temperature2mC!)} °C`],
      'weather-gusts': ['Wind gusts, 10 m (Open-Meteo)', `${oneDecimal(latest.windGusts10mMs!)} m/s`],
      'weather-precipitation': [
        'Precipitation per 30 min (Open-Meteo)',
        `${oneDecimal(latest.precipitationMm!)} mm`,
      ],
    };
    for (const metric of WEATHER_METRICS) {
      const [title, value] = expected[metric];
      const c = chart(page, metric);
      await expect(c.getByTestId('chart-title')).toHaveText(title);
      await expect(c.getByTestId('latest')).toHaveText(value);
      await expect(c.locator('svg').first()).toBeVisible();
      // 49 buckets in the window (Jan 2 00:00 … Jan 3 00:00 inclusive).
      await expect(c.getByRole('img', { name: `${title}: latest` })).toHaveAccessibleName(
        /49 readings\./,
      );
    }

    // The weather was asked for once (never per live reading or re-render).
    expect(seen.filter((r) => isWeatherRequest(r))).toHaveLength(1);
  });

  test('a failing weather request shows the error and Retry, keeps the telemetry, and Retry recovers', async ({
    page,
  }) => {
    await open(page);
    let failing = true;
    const seen = await mockWeather(page, { fail: () => failing });
    await openTurbine(page);

    await expect(weather(page)).toHaveAttribute('data-state', 'error');
    await expect(page.getByTestId('weather-error')).toContainText(
      'Weather is unavailable right now; the telemetry is not affected.',
    );
    const retry = page.getByTestId('weather-retry');
    await expect(retry).toBeVisible();
    await expect(retry).toHaveText('Retry');

    // The telemetry is intact: every metric chart drawn, the readings listed, no weather drawn.
    for (const metric of ['powerOutputKw', 'windSpeedMs', 'rotorRpm', 'bladePitchDeg', 'gearboxTempC']) {
      await expect(chart(page, metric).getByTestId('latest')).toBeVisible();
    }
    await expect(chart(page, 'alerts')).toBeVisible();
    const rows = await readingRows(page).count();
    expect(rows).toBeGreaterThan(1);
    await expect(chart(page, 'windSpeedMs').getByTestId('overlay-legend')).toHaveCount(0);
    for (const metric of WEATHER_METRICS) await expect(chart(page, metric)).toHaveCount(0);

    // The API is healthy again: Retry sends the same request once more and draws the weather.
    failing = false;
    const again = weatherRequest(page, '30min');
    await retry.click();
    expect(weatherQuery(await again)).toEqual(weatherQuery(seen[0]));
    await expect(weather(page)).toHaveAttribute('data-state', 'ok');
    await expect(page.getByTestId('weather-error')).toHaveCount(0);
    await expect(chart(page, 'windSpeedMs').getByTestId('overlay-legend')).toHaveText(OVERLAY);
    for (const metric of WEATHER_METRICS) await expect(chart(page, metric)).toBeVisible();
    await expect(readingRows(page)).toHaveCount(rows);
  });

  test('the real API: no weather synced for the fixture days shows the empty state (or the synced data)', async ({
    page,
  }) => {
    await open(page);
    const response = weatherResponse(page, '30min');
    await openTurbine(page);

    const res: Response = await response;
    expect(res.status()).toBe(200);
    const body = (await res.json()) as {
      farmId: string;
      turbineId: string;
      interval: string;
      timeZone: string;
      points: WeatherSlot[];
    };
    // The response the web model expects (weather.model.ts): no timeZone sent → "UTC".
    expect(body).toMatchObject({ farmId: FARM, turbineId: TURBINE, interval: '30min', timeZone: 'UTC' });
    const windowFrom = NOW_MS - 24 * 60 * 60_000;
    const inWindow = body.points.some((p) => {
      const t = Date.parse(p.time);
      return t + 30 * 60_000 > windowFrom && t <= NOW_MS;
    });

    if (inWindow) {
      // This DB has weather for Jan 2026: the populated view instead.
      await expect(weather(page)).toHaveAttribute('data-state', 'ok');
      await expect(chart(page, 'weather-temperature')).toBeVisible();
    } else {
      await expect(weather(page)).toHaveAttribute('data-state', 'empty');
      await expect(page.getByTestId('weather-empty')).toHaveText('No weather synced for this period.');
      await expect(chart(page, 'windSpeedMs').getByTestId('overlay-legend')).toHaveCount(0);
      for (const metric of WEATHER_METRICS) await expect(chart(page, metric)).toHaveCount(0);
    }
    // The telemetry charts are there either way.
    await expect(chart(page, 'powerOutputKw').getByTestId('latest')).toBeVisible();
  });
});

test.describe('Weather on the farm page', () => {
  test('shows the latest 30-minute tiles and 7 daily rows, today marked partial', async ({ page }) => {
    await open(page);
    await mockWeather(page, { partialLastDay: 1 });
    const recent = weatherRequest(page, '30min');
    const daily = weatherRequest(page, 'daily');
    await page.goto(FARM_URL);

    // Two requests: the last 24 h of buckets (no zone) and the last 7 UTC days.
    expect(weatherQuery(await recent)).toEqual({
      from: '2026-01-02T00:00:00.000Z',
      to: '2026-01-03T00:30:00.000Z',
      interval: '30min',
      timeZone: null,
    });
    expect(weatherQuery(await daily)).toEqual({
      from: '2025-12-28T00:00:00.000Z',
      to: '2026-01-04T00:00:00.000Z',
      interval: 'daily',
      timeZone: 'UTC',
    });

    const section = farmWeather(page);
    await expect(section.getByRole('heading', { name: 'Weather', exact: true })).toBeVisible();
    await expect(page.getByTestId('weather-loading')).toHaveCount(0);

    // Tiles: the newest bucket that has started (00:00, not a later one) and today's range.
    const latest = slotAt(NOW_MS);
    await expect(page.getByTestId('weather-latest-time')).toHaveText(
      'Latest 30 minutes from Jan 3, 00:00 UTC',
    );
    await expect(page.getByTestId('weather-wind')).toHaveText(`${oneDecimal(latest.windSpeed80mMs!)} m/s`);
    await expect(page.getByTestId('weather-gusts')).toHaveText(`${oneDecimal(latest.windGusts10mMs!)} m/s`);
    await expect(page.getByTestId('weather-temperature')).toHaveText(
      `${oneDecimal(latest.temperature2mC!)} °C`,
    );
    await expect(page.getByTestId('weather-precipitation')).toHaveText(
      `${oneDecimal(latest.precipitationMm!)} mm`,
    );
    // Today (Jan 3) is the 7th mocked day: min −6 + 3, max 3 + 3.
    await expect(page.getByTestId('weather-today-temp')).toHaveText('-3.0 / 6.0 °C');

    // Seven daily rows, Dec 28 … Jan 3 (UTC); only today is partial (1 of 48 buckets).
    const table = page.getByTestId('weather-daily');
    await expect(table.getByRole('columnheader').first()).toHaveText('Day (UTC)');
    const days = page.getByTestId('weather-day');
    await expect(days).toHaveCount(7);
    const dates = await days.evaluateAll((rows) => rows.map((r) => r.getAttribute('data-date')));
    expect(dates).toEqual([
      '2025-12-28',
      '2025-12-29',
      '2025-12-30',
      '2025-12-31',
      '2026-01-01',
      '2026-01-02',
      '2026-01-03',
    ]);
    const first = days.first().getByRole('cell');
    await expect(first.first()).toHaveText('Sun, Dec 28');
    await expect(first.nth(1)).toHaveText('6.0'); // 80 m mean
    await expect(first.nth(2)).toHaveText('10.0'); // 80 m max
    await expect(first.nth(3)).toHaveText('-6.0');
    await expect(first.nth(4)).toHaveText('3.0');
    await expect(first.nth(5)).toHaveText('1.5');
    await expect(first.last()).toHaveText('48 / 48');
    await expect(first.last()).not.toHaveAttribute('data-partial');

    const today = page.locator('[data-testid="weather-day"][data-date="2026-01-03"]');
    await expect(today.getByRole('cell').first()).toHaveText('Sat, Jan 3 (today)');
    await expect(today.getByRole('cell').last()).toHaveText('1 / 48');
    await expect(today.getByRole('cell').last()).toHaveAttribute('data-partial', '');
    await expect(page.locator('[data-testid="weather-day"] td[data-partial]')).toHaveCount(1);

    // The farm's own content is still there under the weather.
    await expect(page.getByRole('heading', { name: 'Turbines', exact: true })).toBeVisible();
  });

  test('a failing weather request shows the error; Retry recovers', async ({ page }) => {
    await open(page);
    let failing = true;
    await mockWeather(page, { fail: () => failing, partialLastDay: 1 });
    await page.goto(FARM_URL);

    await expect(page.getByTestId('weather-error')).toContainText('Weather is unavailable right now.');
    await expect(page.getByTestId('weather-daily')).toHaveCount(0);
    await expect(page.getByTestId('weather-wind')).toHaveCount(0);
    // The rest of the farm page is unaffected.
    await expect(page.getByTestId('farm-power')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Turbines', exact: true })).toBeVisible();

    failing = false;
    const retried = Promise.all([weatherRequest(page, '30min'), weatherRequest(page, 'daily')]);
    await page.getByTestId('weather-retry').click();
    await retried;
    await expect(page.getByTestId('weather-error')).toHaveCount(0);
    await expect(page.getByTestId('weather-day')).toHaveCount(7);
    await expect(page.getByTestId('weather-wind')).toHaveText(`${oneDecimal(slotAt(NOW_MS).windSpeed80mMs!)} m/s`);
  });

  test('the real API: the fixture days have no weather synced (or show the synced data)', async ({
    page,
  }) => {
    await open(page);
    const recent = weatherResponse(page, '30min');
    const daily = weatherResponse(page, 'daily');
    await page.goto(FARM_URL);

    const [recentRes, dailyRes] = await Promise.all([recent, daily]);
    expect(recentRes.status()).toBe(200);
    expect(dailyRes.status()).toBe(200);
    const recentBody = (await recentRes.json()) as { interval: string; timeZone: string; points: WeatherSlot[] };
    const dailyBody = (await dailyRes.json()) as { interval: string; timeZone: string; points: WeatherDay[] };
    expect(recentBody).toMatchObject({ farmId: FARM, interval: '30min', timeZone: 'UTC' });
    expect(dailyBody).toMatchObject({ farmId: FARM, interval: 'daily', timeZone: 'UTC' });
    await expect(page.getByTestId('weather-loading')).toHaveCount(0);

    if (recentBody.points.some((p) => Date.parse(p.time) <= NOW_MS)) {
      await expect(page.getByTestId('weather-latest-time')).toBeVisible();
    } else {
      await expect(page.getByTestId('weather-latest-empty')).toHaveText(
        'No weather synced for this period.',
      );
    }
    if (dailyBody.points.length) {
      await expect(page.getByTestId('weather-day')).toHaveCount(dailyBody.points.length);
    } else {
      await expect(page.getByTestId('weather-daily-empty')).toHaveText(
        'No weather synced for this period.',
      );
    }
  });
});

test.describe('Weather days follow the time-zone setting (browser in America/Chicago)', () => {
  test.use({ timezoneId: 'America/Chicago' });

  test('the farm daily request carries timeZone=America/Chicago after switching to Local', async ({
    page,
  }) => {
    // fixBrowserDate, not page.clock, outside UTC (see support/clock.ts).
    await fixBrowserDate(page, SEED_NOW);
    await page.route('**/api/events**', (route) => route.abort());
    await mockWeather(page, { partialLastDay: 37 });
    await logIn(page, 'admin');
    const nav = page.getByRole('navigation', { name: 'Main' });

    // UTC (the default): UTC days.
    let daily: Promise<Request> = weatherRequest(page, 'daily');
    await page.getByTestId('farms').getByRole('link', { name: FARM_NAME, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${FARM_URL}$`));
    expect(weatherQuery(await daily)).toMatchObject({
      from: '2025-12-28T00:00:00.000Z',
      to: '2026-01-04T00:00:00.000Z',
      timeZone: 'UTC',
    });
    await expect(page.getByTestId('weather-daily').getByRole('columnheader').first()).toHaveText(
      'Day (UTC)',
    );

    // Settings → Local, then back to the farm (no reload).
    await nav.getByRole('link', { name: 'Settings' }).click();
    const local = page.getByTestId('time-zone').getByRole('radio', { name: /^Local/ });
    await local.click();
    await expect(local).toHaveAttribute('aria-checked', 'true');

    daily = weatherRequest(page, 'daily');
    const recent = weatherRequest(page, '30min');
    await nav.getByRole('link', { name: 'Farms' }).click();
    await page.getByTestId('farms').getByRole('link', { name: FARM_NAME, exact: true }).click();
    // Jan 2, 18:00 CST: the 7 days Dec 27 … Jan 2, each from 00:00 CST (06:00Z).
    expect(weatherQuery(await daily)).toEqual({
      from: '2025-12-27T06:00:00.000Z',
      to: '2026-01-03T06:00:00.000Z',
      interval: 'daily',
      timeZone: 'America/Chicago',
    });
    // The 30-minute buckets are UTC whatever the setting: no zone sent.
    expect(weatherQuery(await recent).timeZone).toBeNull();

    await expect(page.getByTestId('weather-daily').getByRole('columnheader').first()).toHaveText(
      'Day (local)',
    );
    const days = page.getByTestId('weather-day');
    await expect(days).toHaveCount(7);
    await expect(days.first()).toHaveAttribute('data-date', '2025-12-27');
    const today = days.last();
    await expect(today).toHaveAttribute('data-date', '2026-01-02');
    await expect(today.getByRole('cell').first()).toHaveText('Fri, Jan 2 (today)');
    await expect(today.getByRole('cell').last()).toHaveText('37 / 48');
    await expect(today.getByRole('cell').last()).toHaveAttribute('data-partial', '');
    await expect(page.getByTestId('weather-latest-time')).toHaveText(
      'Latest 30 minutes from Jan 2, 18:00 CST',
    );
  });
});
