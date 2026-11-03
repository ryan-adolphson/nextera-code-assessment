import { expect, test, type Page, type Request, type Response } from '@playwright/test';
import { fixBrowserDate, shortTimeIn } from '../support/clock.js';
import { SEED_NOW, logIn } from '../support/session.js';

// Plan 16: Alerting -> Anomalies and the fleet "Est. lost output" tile. The fixture's TURB001 run
// (0 kW in 15.8 m/s, Jan 1 13:40-13:50Z, 3 readings, inside the 7 days before SEED_NOW) comes from
// the real GET /api/anomalies; expectations are derived from the response the page rendered.
// A stuck sensor, the empty state, errors, MWh formatting and a wide table need data the fixture
// doesn't hold, so those use a served response. Read-only; the live stream is aborted unless the
// test is about it.

const WINDOW_MS = 7 * 86_400_000;
const isAnomalies = (url: string) => /\/api\/anomalies$/.test(new URL(url).pathname);

interface Anomaly {
  turbineId: string;
  farmId: string;
  kind: 'low_power_in_wind' | 'stuck_sensor';
  metric: 'gearboxTempC' | 'windSpeedMs' | 'rotorRpm' | null;
  start: string;
  end: string;
  readings: number;
  value: number | null;
  windSpeedMs: number | null;
  estimatedLostKwh: number | null;
}
interface Report {
  from: string;
  to: string;
  estimatedLostKwh: number;
  anomalies: Anomaly[];
}

const STUCK: Anomaly = {
  turbineId: 'TURB002',
  farmId: 'FARM02',
  kind: 'stuck_sensor',
  metric: 'gearboxTempC',
  start: '2026-01-02T03:20:00.000Z',
  end: '2026-01-02T04:20:00.000Z',
  readings: 13,
  value: 126.5,
  windSpeedMs: null,
  estimatedLostKwh: null,
};
const LOW: Anomaly = {
  turbineId: 'TURB001',
  farmId: 'FARM01',
  kind: 'low_power_in_wind',
  metric: null,
  start: '2026-01-01T13:40:00.000Z',
  end: '2026-01-01T13:50:00.000Z',
  readings: 3,
  value: null,
  windSpeedMs: 15.8,
  estimatedLostKwh: 850,
};
const report = (anomalies: Anomaly[], estimatedLostKwh: number): Report => ({
  from: new Date(SEED_NOW.getTime() - WINDOW_MS).toISOString(),
  to: SEED_NOW.toISOString(),
  estimatedLostKwh,
  anomalies,
});

/** formatEnergy of the app: "850 kWh" under 1,000, else "1.3 MWh". */
const energy = (kwh: number) =>
  Math.abs(kwh) < 1000
    ? `${Math.round(kwh).toLocaleString('en-US')} kWh`
    : `${(kwh / 1000).toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MWh`;

/** Serves `body` (or a 500) for GET /api/anomalies, counting the requests. */
async function serve(page: Page, body: Report | 500): Promise<Request[]> {
  const requests: Request[] = [];
  await page.route(
    (url) => isAnomalies(url.href),
    (route) => {
      requests.push(route.request());
      return body === 500
        ? route.fulfill({ status: 500, json: { message: 'boom' } })
        : route.fulfill({ json: body });
    },
  );
  return requests;
}

const anomaliesResponse = (page: Page): Promise<Response> =>
  page.waitForResponse((r) => isAnomalies(r.url()) && r.request().method() === 'GET');

/** The page's own response, parsed. */
async function reportFrom(response: Promise<Response>): Promise<Report> {
  const res = await response;
  expect(res.status(), 'GET /api/anomalies').toBe(200);
  return (await res.json()) as Report;
}

/** Fixed clock, no live stream, signed in as `role` (ends on /farms). */
async function signedIn(page: Page, role: 'viewer' | 'owner' | 'admin' = 'viewer'): Promise<void> {
  await page.clock.setFixedTime(SEED_NOW);
  await page.route('**/api/events**', (route) => route.abort());
  // /farms loads the fleet tile's anomalies: let that request finish so it isn't counted later.
  const tile = anomaliesResponse(page);
  await logIn(page, role);
  await tile;
}

/** Signed in, then straight to the tab (a fresh load: one anomalies request). */
async function openTab(page: Page, role: 'viewer' | 'owner' | 'admin' = 'viewer'): Promise<void> {
  await signedIn(page, role);
  await page.goto('/alerting/anomalies');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Alerting');
}

const rows = (page: Page) => page.getByTestId('anomaly');

test.describe('Anomalies tab', () => {
  test('a viewer reaches it from the Alerting tabs, selected, and sees the note', async ({
    page,
  }) => {
    await signedIn(page, 'viewer');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Alerting' }).click();
    await page.getByTestId('alerting-tab-anomalies').click();

    await expect(page).toHaveURL(/\/alerting\/anomalies$/);
    await expect(page.getByTestId('alerting-tab-anomalies')).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByTestId('anomalies-note')).toContainText(
      'Lost output is an estimate from the median output of the fleet at the same wind speed.',
    );
  });

  test('shows the fixture low-power run of TURB001 as the API reports it', async ({ page }) => {
    await signedIn(page);
    const response = anomaliesResponse(page);
    await page.goto('/alerting/anomalies');
    const data = await reportFrom(response);

    const expected = data.anomalies.find(
      (a) => a.turbineId === 'TURB001' && a.kind === 'low_power_in_wind',
    );
    expect(expected, 'TURB001 low_power_in_wind (npm run db:seed)').toBeTruthy();
    const row = rows(page).and(page.locator('[data-turbine-id="TURB001"][data-kind="low_power_in_wind"]'));
    await expect(row).toHaveCount(1);

    await expect(row.getByTestId('anomaly-kind')).toHaveText('Low power in strong wind');
    await expect(row.getByTestId('anomaly-farm')).toContainText(expected!.farmId);
    await expect(row.getByTestId('anomaly-detail')).toHaveText(
      `Mean wind ${expected!.windSpeedMs!.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} m/s`,
    );
    await expect(row.getByTestId('anomaly-start')).toHaveText(
      `${shortTimeIn(expected!.start, 'UTC')} UTC`,
    );
    const minutes = (Date.parse(expected!.end) - Date.parse(expected!.start)) / 60_000 + 5;
    await expect(row.getByTestId('anomaly-duration')).toHaveText(
      [Math.floor(minutes / 60) && `${Math.floor(minutes / 60)} h`, minutes % 60 && `${minutes % 60} min`]
        .filter(Boolean)
        .join(' '),
    );
    await expect(row.getByTestId('anomaly-lost')).toHaveText(
      expected!.estimatedLostKwh === null ? '–' : energy(expected!.estimatedLostKwh),
    );
    await expect(page.getByTestId('anomalies-total')).toContainText(energy(data.estimatedLostKwh));
  });

  test('the turbine link opens that turbine page', async ({ page }) => {
    await signedIn(page);
    const response = anomaliesResponse(page);
    await page.goto('/alerting/anomalies');
    const data = await reportFrom(response);
    const a = data.anomalies.find((x) => x.turbineId === 'TURB001')!;
    expect(a, 'TURB001 anomaly (npm run db:seed)').toBeTruthy();

    await rows(page)
      .and(page.locator('[data-turbine-id="TURB001"]'))
      .first()
      .getByTestId('anomaly-turbine')
      .click();

    await expect(page).toHaveURL(new RegExp(`/farms/${a.farmId}/turbines/TURB001$`));
    await expect(page.getByRole('heading', { level: 1 })).toContainText('TURB001');
  });

  test('sends one request for the last 7 days ending at the browser clock', async ({ page }) => {
    await signedIn(page);
    const requests: Request[] = [];
    page.on('request', (r) => {
      if (isAnomalies(r.url())) requests.push(r);
    });
    const response = anomaliesResponse(page);
    await page.goto('/alerting/anomalies');
    await response;
    await expect(page.getByTestId('anomalies')).toBeVisible();

    expect(requests).toHaveLength(1);
    const q = new URL(requests[0].url()).searchParams;
    expect(q.get('to')).toBe(SEED_NOW.toISOString());
    expect(q.get('from')).toBe(new Date(SEED_NOW.getTime() - WINDOW_MS).toISOString());
    expect([...q.keys()].sort()).toEqual(['from', 'to']);
  });

  test('a stuck sensor shows its gearbox text and "–" for the lost output, with the total and note', async ({
    page,
  }) => {
    await serve(page, report([LOW, STUCK], 850));
    await openTab(page);

    const stuck = page.locator('[data-testid="anomaly"][data-kind="stuck_sensor"]');
    await expect(stuck).toHaveCount(1);
    await expect(stuck.getByTestId('anomaly-kind')).toHaveText('Stuck sensor');
    await expect(stuck.getByTestId('anomaly-detail')).toHaveText('Gearbox temperature stuck at 126.5 °C');
    await expect(stuck.getByTestId('anomaly-lost')).toHaveText('–');
    await expect(stuck.getByTestId('anomaly-duration')).toHaveText('1 h 5 min');
    await expect(
      page.locator('[data-testid="anomaly"][data-kind="low_power_in_wind"]').getByTestId('anomaly-lost'),
    ).toHaveText('850 kWh');
    await expect(page.getByTestId('anomalies-total')).toHaveText(/Estimated lost output:\s*850 kWh/);
    await expect(page.getByTestId('anomalies-note')).toBeVisible();
  });

  test('shows the empty state when nothing was found', async ({ page }) => {
    await serve(page, report([], 0));
    await openTab(page);

    await expect(page.getByTestId('anomalies-empty')).toHaveText('No anomalies in the last 7 days.');
    await expect(page.getByTestId('anomalies')).toHaveCount(0);
    await expect(page.getByTestId('anomalies-total')).toHaveCount(0);
  });

  test('a server error shows the message, and Retry loads the data', async ({ page }) => {
    await signedIn(page);
    let fail = true;
    const requests: Request[] = [];
    await page.route(
      (url) => isAnomalies(url.href),
      (route) => {
        requests.push(route.request());
        return fail
          ? route.fulfill({ status: 500, json: { message: 'boom' } })
          : route.fulfill({ json: report([LOW], 850) });
      },
    );
    await page.goto('/alerting/anomalies');

    await expect(page.getByTestId('anomalies-error')).toHaveText(/The anomalies could not be loaded\./);
    await expect(page.getByTestId('anomalies')).toHaveCount(0);
    expect(requests).toHaveLength(1);

    fail = false;
    await page.getByTestId('anomalies-retry').click();
    await expect(rows(page)).toHaveCount(1);
    await expect(page.getByTestId('anomalies-error')).toHaveCount(0);
    expect(requests).toHaveLength(2);
  });

  test('a live reading does not reload the anomalies', async ({ page }) => {
    await page.clock.setFixedTime(SEED_NOW);
    let armed = false;
    let streams = 0;
    await page.route('**/api/events**', (route) => {
      if (!armed) return route.abort();
      streams += 1;
      // The first stream of the Anomalies page delivers one reading and ends: the browser
      // reconnects (retry 200 ms) and that request goes to the real API.
      return streams === 1
        ? route.fulfill({
            headers: { 'content-type': 'text/event-stream' },
            body: `retry: 200\n\nevent: telemetry.received\nid: 1-0\ndata: ${JSON.stringify({
              id: 'live-1',
              turbineId: 'TURB001',
              farmId: 'FARM01',
              timestamp: SEED_NOW.toISOString(),
              receivedAt: SEED_NOW.toISOString(),
              powerOutputKw: 0,
              windSpeedMs: 15.8,
              rotorRpm: 0,
              bladePitchDeg: 0,
              gearboxTempC: 60,
              alerts: [],
            })}\n\n`,
          })
        : route.fallback();
    });
    await logIn(page, 'viewer');
    const requests = await serve(page, report([LOW], 850));
    armed = true;
    await page.goto('/alerting/anomalies');
    await expect(rows(page)).toHaveCount(1);

    // Two streams: the one that carried the reading, and the reconnect after it.
    await expect.poll(() => streams).toBeGreaterThanOrEqual(2);
    await expect(page.getByTestId('live-status')).toHaveAttribute('data-status', 'open');
    expect(requests).toHaveLength(1);
    await expect(rows(page)).toHaveCount(1);
  });
});

test.describe('Fleet tile: estimated lost output', () => {
  test('shows the API total, and its link opens the Anomalies tab', async ({ page }) => {
    await page.clock.setFixedTime(SEED_NOW);
    await page.route('**/api/events**', (route) => route.abort());
    const response = anomaliesResponse(page);
    await logIn(page, 'viewer');
    const data = await reportFrom(response);

    const tile = page.getByTestId('fleet-lost-output');
    await expect(page.getByRole('region', { name: 'Fleet summary' })).toContainText(
      'Est. lost output (7 days)',
    );
    await expect(tile).toContainText(energy(data.estimatedLostKwh));

    await tile.getByRole('link').click();
    await expect(page).toHaveURL(/\/alerting\/anomalies$/);
    await expect(page.getByTestId('alerting-tab-anomalies')).toHaveAttribute('aria-selected', 'true');
  });

  test('formats kWh under 1,000 and MWh above', async ({ page }) => {
    await serve(page, report([LOW], 1234.5));
    await signedIn(page);
    await expect(page.getByTestId('fleet-lost-output')).toContainText('1.2 MWh');

    await page.unroute((url) => isAnomalies(url.href));
    await serve(page, report([LOW], 999.4));
    await page.reload();
    await expect(page.getByTestId('fleet-lost-output')).toContainText('999 kWh');
  });

  test('a failed request shows "–" and leaves the rest of /farms working', async ({ page }) => {
    await serve(page, 500);
    await signedIn(page);

    const tile = page.getByTestId('fleet-lost-output');
    await expect(tile.getByRole('link')).toHaveText('–');
    await expect(page.getByTestId('fleet-reporting')).toContainText(/\d+ \/ \d+/);
    await expect(page.getByTestId('farms').getByRole('row')).not.toHaveCount(1);
  });
});

test.describe('Anomalies layout in a real browser', () => {
  /** Several rows of both kinds, with a long farm-less detail, so the table is as wide as it gets. */
  const WIDE = report(
    Array.from({ length: 6 }, (_, i) => [
      { ...LOW, turbineId: `TURB00${i + 1}`, start: `2026-01-01T1${i}:40:00.000Z` },
      { ...STUCK, turbineId: `TURB01${i + 1}`, metric: 'rotorRpm' as const, value: 12.5 },
    ]).flat(),
    5100,
  );

  const overflow = (page: Page) =>
    page.evaluate(() => {
      const root = document.documentElement;
      return Math.max(root.scrollWidth, document.body.scrollWidth) - root.clientWidth;
    });

  for (const width of [1280, 360]) {
    test(`no sideways page overflow at ${width} px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 });
      await serve(page, WIDE);
      await openTab(page);
      await expect(rows(page)).toHaveCount(12);

      expect(await overflow(page)).toBeLessThanOrEqual(0);
      const scroll = await page.getByTestId('anomalies-scroll').evaluate((el) => ({
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      }));
      test.info().annotations.push({
        type: `scroll region at ${width} px`,
        description: `scrollWidth ${scroll.scrollWidth}, clientWidth ${scroll.clientWidth}: ${scroll.scrollWidth > scroll.clientWidth ? 'scrolls sideways' : 'fits'}`,
      });
      if (width === 360) expect(scroll.scrollWidth).toBeGreaterThan(scroll.clientWidth);
    });
  }
});

test.describe('Anomalies in a Chicago browser', () => {
  test.use({ timezoneId: 'America/Chicago' });

  test('Local mode shows the start time in Chicago time', async ({ page }) => {
    await fixBrowserDate(page, SEED_NOW);
    await page.route('**/api/events**', (route) => route.abort());
    await serve(page, report([LOW], 850));
    await logIn(page, 'viewer');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Settings' }).click();
    const local = page.getByTestId('time-zone').getByRole('radio', { name: /^Local/ });
    await local.click();
    await expect(local).toHaveAttribute('aria-checked', 'true');

    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Alerting' }).click();
    await page.getByTestId('alerting-tab-anomalies').click();

    // Jan 1 13:40Z = Jan 1 07:40 CST.
    await expect(rows(page).first().getByTestId('anomaly-start')).toHaveText(
      `${shortTimeIn(LOW.start, 'America/Chicago')} CST`,
    );
    expect(shortTimeIn(LOW.start, 'America/Chicago')).toBe('Jan 1, 07:40');
  });
});
