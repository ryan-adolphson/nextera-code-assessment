import { expect, test, type Page, type Request } from '@playwright/test';
import { fixBrowserDate } from '../support/clock.js';
import { SEED_NOW, logIn, signIn } from '../support/session.js';
import {
  isWeatherRequest,
  mockWeather,
  oneDecimal,
  slotAt,
  weatherQuery,
  type WeatherSlot,
} from '../support/weather.js';

// Plan 13.9–13.14: the farm page's tabs (Overview at /farms/:farmId, Weather history at
// /farms/:farmId/weather) and the Weather history tab (FarmWeatherHistoryPage): whole days from a
// Material date range picker (default the last 7 ending today, at most 31, in the zone shown), one
// GET /api/farms/:id/weather?from&to&interval=30min per range, eight line charts behind @defer.
// Read-only.
//
// The db:seed fixture has no weather, so populated views are page.route mocks in the API's
// 30-minute shape (support/weather.ts), answering only the buckets that have started by SEED_NOW
// (as the sync would) with one bucket left out. One test goes to the real API. The live stream is
// cut (abort) so nothing changes the page mid-test. Request counts are taken on a deep link to
// the tab, so the Overview's own weather requests never mix in.

const FARM = 'FARM01';
const FARM_NAME = 'Prairie Ridge';
const TURBINE = 'TURB001';
const FARM_URL = `/farms/${FARM}`;
const WEATHER_URL = `${FARM_URL}/weather`;
const NOW_MS = SEED_NOW.getTime();
/** The bucket the mock leaves out (Jan 1, 12:00 UTC). */
const MISSING = '2026-01-01T12:00:00.000Z';

/** The eight charts, in order: data-metric, title, the slot field and the decimals shown. */
const CHARTS: { key: string; title: string; unit: string; metric: keyof WeatherSlot; decimals: number }[] = [
  { key: 'wind-80m', title: 'Wind speed, 80 m (mean)', unit: 'm/s', metric: 'windSpeed80mMs', decimals: 1 },
  { key: 'wind-10m', title: 'Wind speed, 10 m', unit: 'm/s', metric: 'windSpeed10mMs', decimals: 1 },
  { key: 'gusts', title: 'Wind gusts, 10 m', unit: 'm/s', metric: 'windGusts10mMs', decimals: 1 },
  { key: 'temperature', title: 'Temperature, 2 m', unit: '°C', metric: 'temperature2mC', decimals: 1 },
  { key: 'precipitation', title: 'Precipitation per 30 min', unit: 'mm', metric: 'precipitationMm', decimals: 1 },
  { key: 'humidity', title: 'Relative humidity, 2 m', unit: '%', metric: 'relativeHumidity2mPct', decimals: 0 },
  { key: 'pressure', title: 'Surface pressure', unit: 'hPa', metric: 'surfacePressureHpa', decimals: 0 },
  { key: 'cloud-cover', title: 'Cloud cover', unit: '%', metric: 'cloudCoverPct', decimals: 0 },
];

/** A value as a chart's latest label formats it (en-US, the chart's decimals). */
const shownValue = (v: number, decimals: number) =>
  decimals === 1
    ? oneDecimal(v)
    : v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });

const tabs = (page: Page) => page.getByTestId('farm-tabs');
const overviewTab = (page: Page) => page.getByTestId('farm-tab-overview');
const weatherTab = (page: Page) => page.getByTestId('farm-tab-weather');
const range = (page: Page) => page.getByTestId('weather-history-range');
const startInput = (page: Page) => range(page).getByRole('textbox', { name: 'Start date' });
const endInput = (page: Page) => range(page).getByRole('textbox', { name: 'End date' });
const status = (page: Page) => page.getByTestId('weather-history-status');
const chart = (page: Page, key: string) =>
  page.getByTestId('weather-history-charts').locator(`app-line-chart[data-metric="${key}"]`);

/** The tab's requests among those the mock saw (30-minute buckets). */
const historyRequests = (seen: Request[]) => seen.filter((r) => isWeatherRequest(r, '30min'));

/** Types a day like a user (the native DateAdapter reads en-US M/D/YYYY) and leaves the field. */
async function typeDay(page: Page, which: 'start' | 'end', day: string): Promise<void> {
  const input = which === 'start' ? startInput(page) : endInput(page);
  await input.fill(day);
  await input.blur();
}

/** A UTC browser at SEED_NOW, no live stream, weather mocked, signed in as admin. */
async function open(page: Page, mock: Parameters<typeof mockWeather>[1] = {}): Promise<Request[]> {
  await page.route('**/api/events**', (route) => route.abort());
  const seen = await mockWeather(page, { until: NOW_MS, missing: [MISSING], ...mock });
  await signIn(page, 'admin');
  return seen;
}

test.describe('Farm tabs', () => {
  test('Overview is current on the farm page; Weather history opens its own URL', async ({ page }) => {
    await open(page);
    await page.goto(FARM_URL);

    await expect(tabs(page)).toBeVisible();
    await expect(tabs(page).getByRole('link')).toHaveText(['Overview', 'Weather history']);
    await expect(overviewTab(page)).toHaveAttribute('aria-current', 'page');
    await expect(weatherTab(page)).not.toHaveAttribute('aria-current');
    await expect(page.getByTestId('weather-history-range')).toHaveCount(0);

    await weatherTab(page).click();
    await expect(page).toHaveURL(new RegExp(`${WEATHER_URL}$`));
    await expect(weatherTab(page)).toHaveAttribute('aria-current', 'page');
    await expect(overviewTab(page)).not.toHaveAttribute('aria-current');
    await expect(page).toHaveTitle(`${FARM_NAME} · Weather history · Nextera`);
    await expect(range(page)).toBeVisible();
    // The Overview's content is not on this tab.
    await expect(page.getByTestId('farm-power')).toHaveCount(0);

    await overviewTab(page).click();
    await expect(page).toHaveURL(new RegExp(`${FARM_URL}$`));
    await expect(overviewTab(page)).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('farm-power')).toBeVisible();
  });

  test('a deep link opens Weather history, and the back link returns to all farms', async ({ page }) => {
    await open(page);
    await page.goto(WEATHER_URL);

    await expect(page.getByRole('heading', { level: 1 })).toContainText(`${FARM_NAME} ${FARM}`);
    await expect(weatherTab(page)).toHaveAttribute('aria-current', 'page');
    await expect(range(page)).toBeVisible();

    await page.getByTestId('back-to-farms').click();
    await expect(page).toHaveURL(/\/farms$/);
    await expect(page.getByTestId('farms')).toBeVisible();
  });

  test('an unknown farm on the Weather history URL says it was not found and sends no request', async ({
    page,
  }) => {
    const seen = await open(page);
    await page.goto('/farms/NOPE/weather');

    await expect(page.getByTestId('farm-not-found')).toHaveText('Farm NOPE was not found.');
    await expect(tabs(page)).toHaveCount(0);
    expect(seen).toEqual([]);
  });

  test("a turbine link on Overview still opens the turbine page, which has no tabs", async ({ page }) => {
    await open(page);
    await page.goto(FARM_URL);

    await page.getByTestId('turbines').getByRole('link', { name: TURBINE, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${FARM_URL}/turbines/${TURBINE}$`));
    await expect(page.getByRole('heading', { level: 1 })).toContainText(TURBINE);
    await expect(tabs(page)).toHaveCount(0);
  });
});

test.describe('Weather history tab (mocked API)', () => {
  test('the default range is the last 7 UTC days: one request, eight charts with latest values', async ({
    page,
  }) => {
    const seen = await open(page);
    await page.goto(WEATHER_URL);

    await expect(range(page)).toContainText('Dates (UTC)');
    await expect(startInput(page)).toHaveValue('12/28/2025');
    await expect(endInput(page)).toHaveValue('1/3/2026');

    // Dec 28 … Jan 3 (UTC): 336 half-hours; the mock has those up to 00:00 Jan 3 (289), one left out.
    await expect(status(page)).toHaveText('288 of 336 half-hours synced');
    const requests = historyRequests(seen);
    expect(requests).toHaveLength(1);
    expect(weatherQuery(requests[0])).toEqual({
      from: '2025-12-28T00:00:00.000Z',
      to: '2026-01-04T00:00:00.000Z',
      interval: '30min',
      timeZone: null,
    });

    // The charts (a deferred chunk) in order, each titled with the newest bucket's value.
    const charts = page.getByTestId('weather-history-charts').locator('app-line-chart');
    await expect(charts).toHaveCount(CHARTS.length);
    expect(await charts.evaluateAll((els) => els.map((e) => e.getAttribute('data-metric')))).toEqual(
      CHARTS.map((c) => c.key),
    );
    const latest = slotAt(NOW_MS);
    for (const c of CHARTS) {
      const card = chart(page, c.key);
      await expect(card.getByTestId('chart-title')).toHaveText(c.title);
      await expect(card.getByTestId('latest')).toHaveText(
        `${shownValue(latest[c.metric] as number, c.decimals)} ${c.unit}`,
      );
      await expect(card.locator('svg').first()).toBeVisible();
    }
    await expect(page.getByTestId('weather-history-empty')).toHaveCount(0);
    await expect(page.getByTestId('weather-history-error')).toHaveCount(0);
    await expect(page.getByTestId('charts-load-error')).toHaveCount(0);
    // Not zoomed: no Reset zoom.
    await expect(page.getByTestId('weather-history-reset-zoom')).toHaveCount(0);
  });

  test('changing a day sends exactly one request with the new bounds', async ({ page }) => {
    const seen = await open(page);
    await page.goto(WEATHER_URL);
    await expect(status(page)).toHaveText('288 of 336 half-hours synced');

    // Start → Dec 30: Dec 30 … Jan 3 (240 half-hours; 193 started by 00:00 Jan 3, one missing).
    await typeDay(page, 'start', '12/30/2025');
    await expect(status(page)).toHaveText('192 of 240 half-hours synced');
    expect(historyRequests(seen).map(weatherQuery)).toEqual([
      expect.objectContaining({ from: '2025-12-28T00:00:00.000Z' }),
      { from: '2025-12-30T00:00:00.000Z', to: '2026-01-04T00:00:00.000Z', interval: '30min', timeZone: null },
    ]);

    // End → Jan 1: Dec 30 … Jan 1 (144 half-hours, all in the past, one missing).
    await typeDay(page, 'end', '1/1/2026');
    await expect(status(page)).toHaveText('143 of 144 half-hours synced');
    const requests = historyRequests(seen);
    expect(requests).toHaveLength(3);
    expect(weatherQuery(requests[2])).toEqual({
      from: '2025-12-30T00:00:00.000Z',
      to: '2026-01-02T00:00:00.000Z',
      interval: '30min',
      timeZone: null,
    });
    await expect(chart(page, 'wind-80m').getByTestId('latest')).toHaveText(
      `${oneDecimal(slotAt(Date.parse('2026-01-01T23:30:00Z')).windSpeed80mMs!)} m/s`,
    );
  });

  test('a range over 31 days shows the inline error and sends no request', async ({ page }) => {
    const seen = await open(page);
    await page.goto(WEATHER_URL);
    await expect(status(page)).toHaveText('288 of 336 half-hours synced');

    // Dec 1 … Jan 3: 34 days.
    await typeDay(page, 'start', '12/1/2025');
    await expect(page.getByTestId('weather-history-range-error')).toHaveText('Choose at most 31 days.');
    await expect(status(page)).toHaveText('Choose at most 31 days.');

    // Dec 1 … Dec 31: exactly 31 days is allowed, and is the only request since the default.
    await typeDay(page, 'end', '12/31/2025');
    await expect(page.getByTestId('weather-history-range-error')).toHaveCount(0);
    await expect(status(page)).toHaveText('1488 of 1488 half-hours synced');
    const requests = historyRequests(seen);
    expect(requests).toHaveLength(2);
    expect(weatherQuery(requests[1])).toEqual({
      from: '2025-12-01T00:00:00.000Z',
      to: '2026-01-01T00:00:00.000Z',
      interval: '30min',
      timeZone: null,
    });
  });

  test('a failing request shows the error without charts; Retry recovers', async ({ page }) => {
    let failing = true;
    const seen = await open(page, { fail: () => failing });
    await page.goto(WEATHER_URL);

    await expect(page.getByTestId('weather-history-error')).toContainText(
      'The weather could not be loaded.',
    );
    await expect(page.getByTestId('weather-history-charts')).toHaveCount(0);
    await expect(page.getByTestId('weather-history-empty')).toHaveCount(0);
    expect(historyRequests(seen)).toHaveLength(1);

    failing = false;
    await page.getByTestId('weather-history-retry').click();
    await expect(page.getByTestId('weather-history-error')).toHaveCount(0);
    await expect(status(page)).toHaveText('288 of 336 half-hours synced');
    await expect(page.getByTestId('weather-history-charts').locator('app-line-chart')).toHaveCount(
      CHARTS.length,
    );
    const requests = historyRequests(seen);
    expect(requests).toHaveLength(2);
    expect(weatherQuery(requests[1])).toEqual(weatherQuery(requests[0]));
  });
});

test.describe('Weather history tab (real API)', () => {
  test('the fixture days show "No weather synced for these days." (or the synced charts)', async ({
    page,
  }) => {
    await page.route('**/api/events**', (route) => route.abort());
    await signIn(page, 'admin');
    const response = page.waitForResponse((r) => isWeatherRequest(r.request(), '30min'));
    await page.goto(WEATHER_URL);

    const res = await response;
    expect(res.status()).toBe(200);
    expect(weatherQuery(res.request())).toMatchObject({
      from: '2025-12-28T00:00:00.000Z',
      to: '2026-01-04T00:00:00.000Z',
    });
    const body = (await res.json()) as { farmId: string; interval: string; points: WeatherSlot[] };
    expect(body).toMatchObject({ farmId: FARM, interval: '30min' });

    const metrics = CHARTS.map((c) => c.metric);
    const withData = body.points.filter((p) => metrics.some((m) => p[m] !== null)).length;
    await expect(status(page)).toHaveText(`${withData} of 336 half-hours synced`);
    if (withData > 0) {
      await expect(page.getByTestId('weather-history-charts').locator('app-line-chart')).toHaveCount(
        CHARTS.length,
      );
    } else {
      await expect(page.getByTestId('weather-history-empty')).toHaveText(
        'No weather synced for these days.',
      );
      await expect(page.getByTestId('weather-history-charts')).toHaveCount(0);
    }
  });
});

test.describe('Weather history days follow the time-zone setting (browser in America/Chicago)', () => {
  test.use({ timezoneId: 'America/Chicago' });

  test('Local labels the range "Dates (local)" and asks for local midnights (06:00Z)', async ({ page }) => {
    // fixBrowserDate, not page.clock, outside UTC (see support/clock.ts).
    await fixBrowserDate(page, SEED_NOW);
    await page.route('**/api/events**', (route) => route.abort());
    const seen = await mockWeather(page, { until: NOW_MS, missing: [MISSING] });
    await logIn(page, 'admin');

    // UTC (the default): the UTC days Dec 28 … Jan 3.
    await page.goto(WEATHER_URL);
    await expect(range(page)).toContainText('Dates (UTC)');
    await expect(status(page)).toHaveText('288 of 336 half-hours synced');
    expect(weatherQuery(historyRequests(seen)[0])).toMatchObject({
      from: '2025-12-28T00:00:00.000Z',
      to: '2026-01-04T00:00:00.000Z',
    });

    // Settings → Local (saved per user in this browser), then the tab again.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }).click();
    const local = page.getByTestId('time-zone').getByRole('radio', { name: /^Local/ });
    await local.click();
    await expect(local).toHaveAttribute('aria-checked', 'true');
    await page.goto(WEATHER_URL);

    // Jan 2, 18:00 CST: Dec 27 … Jan 2, each from 00:00 CST (06:00Z).
    await expect(range(page)).toContainText('Dates (local)');
    await expect(startInput(page)).toHaveValue('12/27/2025');
    await expect(endInput(page)).toHaveValue('1/2/2026');
    // 336 half-hours; those started by 00:00Z Jan 3 (325), one missing.
    await expect(status(page)).toHaveText('324 of 336 half-hours synced');
    const requests = historyRequests(seen);
    expect(requests).toHaveLength(2);
    expect(weatherQuery(requests[1])).toEqual({
      from: '2025-12-27T06:00:00.000Z',
      to: '2026-01-03T06:00:00.000Z',
      interval: '30min',
      timeZone: null,
    });
  });
});
