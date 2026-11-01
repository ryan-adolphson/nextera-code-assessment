import { expect, test, type Page, type Response } from '@playwright/test';
import { mainNav } from '../support/fleet.js';
import { SEED_NOW, logIn } from '../support/session.js';

// Plan 8: Reporting (owner). The form's validation and autocomplete, a turbine and a farm report
// against the real GET /api/reports/telemetry (the db:seed fixture's Jan 1–2; expectations from
// the response), the charts, the table, the CSV download, the range limit, an empty range and
// Retry. Read-only; live stream aborted.

interface ReportReading {
  turbineId: string;
  farmId: string;
  timestamp: string;
  receivedAt: string;
  powerOutputKw: number;
  windSpeedMs: number;
  rotorRpm: number;
  bladePitchDeg: number;
  gearboxTempC: number;
  alerts: unknown[];
}
interface Report {
  scope: { kind: 'farm' | 'turbine'; id: string; name: string };
  from: string;
  to: string;
  readings: ReportReading[];
}

const isReport = (url: string) => /\/api\/reports\/telemetry$/.test(new URL(url).pathname);

async function openReporting(page: Page): Promise<void> {
  await page.clock.setFixedTime(SEED_NOW);
  await page.route('**/api/events**', (route) => route.abort());
  await logIn(page, 'owner');
  await mainNav(page).getByRole('link', { name: 'Reporting' }).click();
  await expect(page).toHaveURL(/\/reporting$/);
}

const scope = (page: Page) => page.getByRole('combobox', { name: 'Farm or turbine' });
const run = (page: Page) => page.getByRole('button', { name: 'Run report' });

async function chooseScope(page: Page, text: string, option: RegExp): Promise<void> {
  await scope(page).fill(text);
  await page.getByRole('option', { name: option }).click();
}

async function setDays(page: Page, from: string, to: string): Promise<void> {
  await page.getByRole('textbox', { name: 'Start date' }).fill(from);
  await page.getByRole('textbox', { name: 'End date' }).fill(to);
}

/** Runs the report and resolves the API's answer. */
async function runReport(page: Page): Promise<{ query: URLSearchParams; report: Report }> {
  const response = page.waitForResponse((r: Response) => isReport(r.url()));
  await run(page).click();
  const res = await response;
  expect(res.status()).toBe(200);
  return { query: new URL(res.url()).searchParams, report: (await res.json()) as Report };
}

test.describe('Reporting', () => {
  test('an empty form shows what is missing and sends nothing', async ({ page }) => {
    await openReporting(page);
    const requests: string[] = [];
    page.on('request', (r) => {
      if (isReport(r.url())) requests.push(r.url());
    });
    await expect(page.getByRole('button', { name: 'Download CSV' })).toBeDisabled();
    await expect(scope(page)).toHaveAttribute('placeholder', 'e.g. Prairie Ridge or TURB001');

    await run(page).click();
    await expect(page.getByText('Choose a farm or turbine.', { exact: true })).toBeVisible();
    await expect(page.getByText('Choose the start and end dates.')).toBeVisible();

    await scope(page).fill('abc');
    await setDays(page, '1/1/2026', '1/2/2026');
    await run(page).click();
    await expect(page.getByText('Choose a farm or turbine from the list.')).toBeVisible();
    expect(requests).toEqual([]);
  });

  test('the autocomplete groups farms and turbines and filters as you type', async ({ page }) => {
    await openReporting(page);
    await scope(page).click();
    const listbox = page.getByRole('listbox');
    await expect(listbox.getByRole('group', { name: 'Farms' })).toBeVisible();
    await expect(listbox.getByRole('group', { name: 'Turbines' })).toBeVisible();

    // Options are labelled 'Prairie Ridge (FARM01)' and 'TURB001 · Prairie Ridge'.
    await scope(page).fill('Prairie');
    await expect(listbox.getByRole('group', { name: 'Farms' }).getByRole('option')).toHaveText([
      'Prairie Ridge (FARM01)',
    ]);
    for (const option of await listbox
      .getByRole('group', { name: 'Turbines' })
      .getByRole('option')
      .allTextContents())
      expect(option).toContain('· Prairie Ridge');

    await scope(page).fill('farm01');
    await expect(listbox.getByRole('group')).toHaveCount(1);
    await expect(listbox.getByRole('group', { name: 'Farms' }).getByRole('option')).toHaveText([
      'Prairie Ridge (FARM01)',
    ]);

    await scope(page).fill('TURB001');
    await expect(listbox.getByRole('group')).toHaveCount(1);
    await expect(listbox.getByRole('group', { name: 'Turbines' }).getByRole('option')).toHaveText([
      'TURB001 · Prairie Ridge',
    ]);

    await scope(page).fill('zzz');
    await expect(page.getByRole('option')).toHaveCount(0);
  });

  test('a turbine report: summary, one chart per metric plus alerts, table and CSV download', async ({
    page,
  }) => {
    await openReporting(page);
    await chooseScope(page, 'TURB001', /^TURB001/);
    await setDays(page, '1/1/2026', '1/2/2026');
    const { query, report } = await runReport(page);
    expect(Object.fromEntries(query)).toMatchObject({
      turbineId: 'TURB001',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-03T00:00:00.000Z',
    });
    const readings = report.readings;
    expect(readings.length, 'fixture readings on Jan 1–2 (npm run db:seed)').toBeGreaterThan(0);

    await expect(page.getByTestId('report-status')).toHaveText(
      'TURB001 · Prairie Ridge, Jan 1, 2026 – Jan 2, 2026 (UTC)',
    );
    await expect(page.getByTestId('report-readings')).toContainText(
      readings.length.toLocaleString('en-US'),
    );
    await expect(page.getByTestId('report-turbines')).toContainText('1');
    await expect(page.getByText('Every reading of TURB001.')).toBeVisible();

    const charts = page.getByTestId('report-charts').locator('app-line-chart');
    await expect(charts).toHaveCount(6);
    await expect(charts.getByTestId('chart-title')).toHaveText([
      'Power output',
      'Wind speed',
      'Rotor speed',
      'Blade pitch',
      'Gearbox temperature',
      'Alert rules triggered',
    ]);
    for (const chart of await charts.all()) await expect(chart.locator('svg')).toBeVisible();
    await expect(charts.first().locator('div[role="img"]')).toHaveAttribute(
      'aria-label',
      new RegExp(`${readings.length} readings\\.`),
    );

    const table = page.getByTestId('report-table');
    await expect(table.getByRole('columnheader').first()).toHaveText('Measured (UTC)');
    await expect(table.getByTestId('report-row').first().getByRole('cell').first()).toHaveText(
      'Jan 1, 00:00',
    );
    await expect(page.getByTestId('report-paginator')).toContainText(`of ${readings.length}`);

    // The CSV is built in the browser and saved through a download link.
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download CSV' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe('report-TURB001-2026-01-01-2026-01-02.csv');
    const csv = (await (await file.createReadStream()).toArray()).join('');
    const lines = csv.split('\r\n');
    expect(lines[0]).toBe(
      'turbine_id,farm_id,timestamp,received_at,power_output_kw,wind_speed_ms,rotor_rpm,blade_pitch_deg,gearbox_temp_c,alerts',
    );
    expect(lines.at(-1)).toBe(''); // CRLF after the last row
    expect(lines.length - 2).toBe(readings.length);
    const r = readings[0];
    expect(lines[1]).toBe(
      [
        r.turbineId,
        r.farmId,
        r.timestamp,
        r.receivedAt,
        r.powerOutputKw,
        r.windSpeedMs,
        r.rotorRpm,
        r.bladePitchDeg,
        r.gearboxTempC,
        '',
      ].join(','),
    );
  });

  test('a farm report sums its turbines: status names the farm and counts its turbines', async ({
    page,
  }) => {
    await openReporting(page);
    await chooseScope(page, 'Prairie', /^Prairie Ridge \(FARM01\)$/);
    await setDays(page, '1/1/2026', '1/2/2026');
    const { query, report } = await runReport(page);
    expect(query.get('farmId')).toBe('FARM01');
    expect(query.get('turbineId')).toBeNull();

    await expect(page.getByTestId('report-status')).toHaveText(
      'Prairie Ridge (FARM01), Jan 1, 2026 – Jan 2, 2026 (UTC)',
    );
    const turbines = new Set(report.readings.map((r) => r.turbineId));
    await expect(page.getByTestId('report-turbines')).toContainText(String(turbines.size));
    await expect(page.getByTestId('report-readings')).toContainText(
      report.readings.length.toLocaleString('en-US'),
    );
    await expect(
      page.getByText(
        'Farm totals: power is the sum of its turbines, the other values their average.',
      ),
    ).toBeVisible();
    await expect(page.getByTestId('report-charts').locator('app-line-chart')).toHaveCount(6);
    // The table lists every turbine's readings (a Turbine column).
    await expect(page.getByTestId('report-table').getByRole('columnheader').nth(1)).toHaveText(
      'Turbine',
    );
  });

  test('days picked in the calendar show no error mid-pick, and Run sends both', async ({ page }) => {
    await openReporting(page);
    const requests: string[] = [];
    page.on('request', (r) => {
      if (isReport(r.url())) requests.push(r.url());
    });
    await chooseScope(page, 'TURB001', /^TURB001/);
    const start = page.getByRole('textbox', { name: 'Start date' });
    const end = page.getByRole('textbox', { name: 'End date' });

    await page.getByRole('button', { name: 'Open calendar' }).click();
    const calendar = page.getByRole('dialog');
    // Mid-pick: the start is set and the end cleared (and touched), but nothing is reported yet.
    await calendar.getByRole('button', { name: 'January 1, 2026' }).click();
    await expect(start).toHaveValue('1/1/2026');
    await expect(end).toHaveValue('');
    await expect(calendar).toBeVisible();
    await expect(page.getByText('Choose the start and end dates.')).toBeHidden();
    await expect(page.getByTestId('report-range-error')).toHaveCount(0);
    await expect(end).not.toHaveAttribute('aria-invalid', 'true');

    await calendar.getByRole('button', { name: 'January 2, 2026' }).click();
    await expect(calendar).toBeHidden();
    await expect(end).toHaveValue('1/2/2026');
    await expect(page.getByText('Choose the start and end dates.')).toBeHidden();
    await expect(page.getByTestId('report-range-error')).toHaveCount(0);
    expect(requests).toEqual([]);

    const { query } = await runReport(page);
    expect([query.get('turbineId'), query.get('from'), query.get('to')]).toEqual([
      'TURB001',
      '2026-01-01T00:00:00.000Z',
      '2026-01-03T00:00:00.000Z',
    ]);
    expect(requests).toHaveLength(1);
  });

  test('an end day cleared by a half-finished pick is reported once the calendar closes', async ({
    page,
  }) => {
    await openReporting(page);
    const requests: string[] = [];
    page.on('request', (r) => {
      if (isReport(r.url())) requests.push(r.url());
    });
    await chooseScope(page, 'TURB001', /^TURB001/);
    await setDays(page, '1/1/2026', '1/2/2026');

    await page.getByRole('button', { name: 'Open calendar' }).click();
    const calendar = page.getByRole('dialog');
    await calendar.getByRole('button', { name: 'January 1, 2026' }).click();
    await expect(page.getByRole('textbox', { name: 'End date' })).toHaveValue('');
    await expect(page.getByText('Choose the start and end dates.')).toBeHidden();
    await page.keyboard.press('Escape');
    await expect(calendar).toBeHidden();
    await expect(page.getByText('Choose the start and end dates.')).toBeVisible();
    await run(page).click();
    await expect(page.getByText('Choose the start and end dates.')).toBeVisible();
    expect(requests).toEqual([]);
  });

  test('more than 31 days is refused; a range without readings says so', async ({ page }) => {
    await openReporting(page);
    const requests: string[] = [];
    page.on('request', (r) => {
      if (isReport(r.url())) requests.push(r.url());
    });
    await chooseScope(page, 'TURB001', /^TURB001/);
    await setDays(page, '12/1/2025', '1/2/2026');
    await run(page).click();
    await expect(page.getByTestId('report-range-error')).toHaveText('Choose at most 31 days.');
    expect(requests).toEqual([]);

    // Weeks before the fixture (and the demo data): no readings.
    await setDays(page, '12/1/2025', '12/2/2025');
    const { report } = await runReport(page);
    expect(report.readings).toEqual([]);
    await expect(page.getByTestId('report-empty')).toHaveText('No readings in this range.');
    await expect(page.getByRole('button', { name: 'Download CSV' })).toBeDisabled();
    await expect(page.getByTestId('report-charts')).toHaveCount(0);
  });

  test('a failed report shows the error; Retry runs it again', async ({ page }) => {
    let fail = true;
    await page.route(
      (url) => isReport(url.toString()),
      (route) =>
        fail
          ? route.fulfill({
              status: 500,
              json: { statusCode: 500, message: 'Internal server error' },
            })
          : route.continue(),
    );
    await openReporting(page);
    await chooseScope(page, 'TURB001', /^TURB001/);
    await setDays(page, '1/1/2026', '1/2/2026');
    await run(page).click();
    await expect(page.getByTestId('report-error')).toContainText('The report could not be loaded.');

    fail = false;
    const retried = page.waitForResponse((r) => isReport(r.url()) && r.ok());
    await page.getByTestId('report-retry').click();
    await retried;
    await expect(page.getByTestId('report-error')).toHaveCount(0);
    await expect(page.getByTestId('report-status')).toContainText('TURB001 · Prairie Ridge');
  });
});
