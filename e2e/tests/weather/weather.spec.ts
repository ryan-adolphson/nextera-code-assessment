import { expect, test, type Page, type Request } from '@playwright/test';
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

// Plan 13: Open-Meteo weather on the farm page (FarmWeather, the only place the web app shows
// weather), and a guard that the turbine page shows none and sends no weather request. Read-only.
//
// The db:seed fixture has no weather (the sync only fetches recent days), so the populated views
// use page.route mocks in the API's shape (support/weather.ts), built from each request's own
// from/to/timeZone. One test goes to the real API: at the fixture's date it shows the empty state
// (or the data, if this DB happens to have weather for those days).
//
// The clock is fixed at SEED_NOW (2026-01-03T00:00Z): the farm's 7 days end on Jan 3 (UTC). The
// live stream is cut (abort) so no reading from the demo feed or another test changes the page
// mid-test.

const FARM = 'FARM01';
const FARM_NAME = 'Prairie Ridge';
const TURBINE = 'TURB001';
const TURBINE_URL = `/farms/${FARM}/turbines/${TURBINE}`;
const FARM_URL = `/farms/${FARM}`;
const NOW_MS = SEED_NOW.getTime();

const farmWeather = (page: Page) => page.getByTestId('farm-weather');

/** The next weather request of `interval` (sent by the page). */
const weatherRequest = (page: Page, interval: '30min' | 'daily') =>
  page.waitForRequest((r) => isWeatherRequest(r, interval));
const weatherResponse = (page: Page, interval: '30min' | 'daily') =>
  page.waitForResponse((r) => isWeatherRequest(r.request(), interval));

/** A UTC browser at SEED_NOW, no live stream, signed in as admin. */
async function open(page: Page): Promise<void> {
  await page.route('**/api/events**', (route) => route.abort());
  await signIn(page, 'admin');
}

test.describe('No weather on the turbine page', () => {
  test('the turbine page shows no weather and sends no weather request', async ({ page }) => {
    await open(page);
    // History bounded at SEED_NOW so a DB with later demo readings still draws the fixture's Jan 2.
    await boundTelemetryAt(page, SEED_NOW);
    // Any weather request (the API still has GET /api/turbines/:id/weather; the page must not call it).
    const weatherCalls: string[] = [];
    page.on('request', (r) => {
      if (new URL(r.url()).pathname.endsWith('/weather')) weatherCalls.push(r.url());
    });
    const history = page.waitForResponse((r) =>
      new RegExp(`/api/turbines/${TURBINE}/telemetry$`).test(new URL(r.url()).pathname),
    );
    const stats = page.waitForResponse((r) =>
      new RegExp(`/api/turbines/${TURBINE}/telemetry/stats$`).test(new URL(r.url()).pathname),
    );
    await page.goto(TURBINE_URL);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(TURBINE);
    // The page's own loads have answered (the weather used to be asked for alongside them).
    expect((await history).status()).toBe(200);
    expect((await stats).status()).toBe(200);
    // The wind chart is drawn (it used to carry the farm's 80 m overlay).
    const wind = page.locator('app-line-chart[data-metric="windSpeedMs"]');
    await expect(wind.getByTestId('latest')).toBeVisible();

    await expect(page.getByTestId('weather')).toHaveCount(0);
    await expect(page.getByTestId('weather-heading')).toHaveCount(0);
    await expect(page.getByTestId('overlay-legend')).toHaveCount(0);
    expect(weatherCalls).toEqual([]);
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
