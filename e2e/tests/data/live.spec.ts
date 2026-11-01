import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createTurbine, mainNav } from '../support/fleet.js';
import { ensureRule } from '../support/rules.js';
import { INGESTION_URL, apiToken, signIn } from '../support/session.js';
import { telemetryCsv, turbineTelemetry, uploadTelemetry } from '../support/telemetry.js';
import { removeUnallocated } from '../support/unallocated.js';

/**
 * [DATA] Live updates end to end (plan 9.2–9.4, 9.6, 6.4, 7.9, 3.10, 8.8 with alerts): readings
 * uploaded to the ingestion worker (:8081) are stored, evaluated against the enabled rules, and
 * reach open pages over SSE without a reload: the Turbines row, the turbine page (readings table
 * alert pill + tooltip, the alerts chart), Alerting History (expanded chips) and the report CSV.
 *
 * Re-runnable on the same database (fixture + demo data + demo feed):
 * - The turbine is new per run (`E2E-<run>-LV` on FARM04: held, then assigned through the API), so
 *   its readings are only these tests' (22:50, 22:55, 23:58, 23:59 on Jan 2; the browser clock is
 *   fixed at SEED_NOW = Jan 3, 00:00) and no other test sees them change.
 * - The rule "Rotor speed above 50 rpm → Warning" fires only on this turbine's 55 rpm reading
 *   (turbines turn at ~10–20 rpm). After the tests it is deleted, or, since readings triggered it
 *   (telemetry_alerts restricts deletes: 409), disabled; the next run finds and re-enables it.
 * Left behind (no turbine/telemetry delete API): the turbine and its four readings, and the
 * disabled rule. `docker compose down -v` + `db:seed` clears them.
 */

/** New per run (and per repetition: set in beforeAll). */
let TURBINE = '';
const FARM = 'FARM04';
const RULE = {
  measurementMetric: 'rotorRpm',
  comparison: 'above',
  valueMetric: 50,
  alertLevel: 'warn',
} as const;
const TOOLTIP = 'Warning: Rotor speed 55 rpm > 50';

let cleanupRule: ((request: APIRequestContext) => Promise<void>) | undefined;
let ruleId = '';

async function markDocument(page: Page): Promise<void> {
  await page.evaluate(() => ((window as { e2eNoReload?: boolean }).e2eNoReload = true));
}
async function expectSameDocument(page: Page): Promise<void> {
  expect(await page.evaluate(() => (window as { e2eNoReload?: boolean }).e2eNoReload)).toBe(true);
}

test.describe('[DATA] Live updates through ingestion', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ request }) => {
    TURBINE = `E2E-${Date.now().toString(36).toUpperCase()}-LV`;
    const token = await apiToken(request, 'owner');
    const ensured = await ensureRule(request, token, RULE);
    cleanupRule = ensured.cleanup;
    ruleId = ensured.rule.id;
    // 22:55 is the latest: 65 min before the browser clock, so the turbine reads as stale.
    await createTurbine(request, token, TURBINE, FARM, [
      { timestamp: '2026-01-02T22:50:00Z', powerOutputKw: 1200 },
      { timestamp: '2026-01-02T22:55:00Z', powerOutputKw: 1250 },
    ]);
  });

  test.afterAll(async ({ request }) => {
    await cleanupRule?.(request);
    await removeUnallocated(
      request,
      await apiToken(request, 'owner'),
      (e) => e.turbineId === TURBINE,
    );
  });

  test('[DATA] a new reading turns a stale Turbines row back to Reporting, without a reload', async ({
    page,
    request,
  }) => {
    await signIn(page, 'owner');
    await expect(page.getByTestId('live-status')).toHaveText('Live');
    await mainNav(page).getByRole('link', { name: 'Turbines' }).click();
    await page.getByRole('searchbox', { name: 'Turbine or farm' }).fill(TURBINE);
    const row = page.locator(`tr[data-turbine-id="${TURBINE}"]`);
    const cells = row.getByRole('cell');
    await expect(cells.nth(2)).toHaveText('No data in 60 min');
    await expect(cells.nth(7)).toHaveText('Jan 2, 22:55');
    await markDocument(page);

    expect(
      await uploadTelemetry(request, [
        {
          turbineId: TURBINE,
          farmId: FARM,
          timestamp: '2026-01-02T23:58:00Z',
          powerOutputKw: 1777,
        },
      ]),
    ).toMatchObject({ rows: 1, inserted: 1 });

    await expect(cells.nth(2)).toHaveText('Reporting');
    await expect(cells.nth(7)).toHaveText('Jan 2, 23:58');
    await expect(cells.nth(4)).toHaveText('1,777');
    await expectSameDocument(page);
  });

  test('[DATA] a flagged reading joins the turbine page live, with its alert pill and tooltip', async ({
    page,
    request,
  }) => {
    await signIn(page, 'owner');
    await page.goto(`/farms/${FARM}/turbines/${TURBINE}`);
    await expect(page.getByTestId('live-status')).toHaveText('Live');
    const rows = page.getByTestId('history').getByRole('row');
    await expect(rows).toHaveCount(4); // header + 22:50, 22:55, 23:58
    await expect(rows.nth(1).getByRole('cell').first()).toHaveText('Jan 2, 23:58');
    await expect(page.getByTestId('reading-alerts')).toHaveText(['–', '–', '–']);
    await markDocument(page);

    expect(
      await uploadTelemetry(request, [
        { turbineId: TURBINE, farmId: FARM, timestamp: '2026-01-02T23:59:00Z', rotorRpm: 55 },
      ]),
    ).toMatchObject({ rows: 1, inserted: 1 });

    await expect(page.getByTestId('status')).toContainText('Latest reading Jan 2, 23:59 UTC');
    await expect(rows).toHaveCount(5);
    const newest = rows.nth(1);
    await expect(newest.getByRole('cell').first()).toHaveText('Jan 2, 23:59');
    await expect(newest.getByRole('cell').nth(4)).toHaveText('55.0');
    const pill = newest.getByTestId('alerts-cell-trigger');
    await expect(pill.getByTestId('level-count')).toHaveText(['Warning: 1']);
    await expect(pill.getByTestId('level-count')).toHaveAttribute('data-level', 'warn');
    // The rules are the button's accessible description and a Material tooltip (the app's
    // `app-tooltip` class; the overlay has no tooltip role) that a click shows.
    await expect(pill).toHaveAccessibleDescription(TOOLTIP);
    await pill.click();
    await expect(page.locator('.app-tooltip')).toHaveText(TOOLTIP);

    // The alerts chart marks the reading, and the rotor chart's latest value is the new one.
    const alertsChart = page.locator('app-line-chart[data-metric="alerts"]');
    await expect(alertsChart.getByTestId('marker-legend')).toContainText('Warning 1');
    await expect(
      page.locator('app-line-chart[data-metric="rotorRpm"]').getByTestId('latest'),
    ).toHaveText('55.0 rpm');
    await expectSameDocument(page);
  });

  test('[DATA] Alerting History lists the flagged reading; expanding shows its chip', async ({
    page,
  }) => {
    await signIn(page, 'viewer');
    await mainNav(page).getByRole('link', { name: 'Alerting' }).click();
    const row = page.locator(`[data-testid="history-turbine"][data-turbine-id="${TURBINE}"]`);
    await expect(row.getByTestId('level-count')).toHaveText(['Warning: 1']);
    await expect(row.getByRole('cell').nth(2)).toHaveText(`Buffalo Creek ${FARM}`);
    await expect(row.getByRole('cell').nth(3)).toHaveText('Jan 2, 23:59');

    await row.getByRole('button', { name: `Show readings for ${TURBINE}` }).click();
    const reading = page
      .getByRole('list', { name: `Readings for ${TURBINE}` })
      .getByTestId('history-reading');
    await expect(reading).toHaveCount(1);
    await expect(reading).toContainText('Jan 2, 23:59');
    await expect(reading.getByTestId('alert-chip')).toHaveText([TOOLTIP]);
    await expect(reading.getByTestId('alert-chip')).toHaveAttribute('data-level', 'warn');
  });

  test('[DATA] the report shows the alert and its CSV names the rule', async ({ page }) => {
    await signIn(page, 'owner');
    await mainNav(page).getByRole('link', { name: 'Reporting' }).click();
    await page.getByRole('combobox', { name: 'Farm or turbine' }).fill(TURBINE);
    await page.getByRole('option', { name: new RegExp(`^${TURBINE}`) }).click();
    await page.getByRole('textbox', { name: 'Start date' }).fill('1/2/2026');
    await page.getByRole('textbox', { name: 'End date' }).fill('1/2/2026');
    await page.getByRole('button', { name: 'Run report' }).click();
    await expect(page.getByTestId('report-readings')).toContainText('4');
    await expect(page.getByTestId('report-alerts')).toContainText('1');
    await expect(
      page.getByTestId('report-row-alerts').getByTestId('alerts-cell-trigger'),
    ).toHaveText(/Warning\s*1/);

    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download CSV' }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(`report-${TURBINE}-2026-01-02-2026-01-02.csv`);
    const lines = (await (await file.createReadStream()).toArray()).join('').split('\r\n');
    const flagged = lines.filter((l) => l.includes('2026-01-02T23:59:00.000Z'));
    expect(flagged).toHaveLength(1);
    expect(flagged[0].endsWith(',warn:rotor_rpm above 50')).toBe(true);
  });

  test('[DATA] a rule that readings triggered can’t be deleted: the dialog says why and stays open', async ({
    page,
  }) => {
    await signIn(page, 'owner');
    await page.goto('/alerting/rules');
    const row = page.locator(`[data-testid="rule"][data-rule-id="${ruleId}"]`);
    await expect(row).toContainText('Rotor speed');
    await row.getByRole('button', { name: /^Delete rule: Rotor speed above 50 rpm/ }).click();
    const dialog = page.getByTestId('delete-dialog');
    await expect(dialog).toContainText('Rotor speed above 50 rpm (Warning) will be removed.');
    await dialog.getByTestId('confirm-delete').click();
    await expect(dialog.getByTestId('delete-error')).toContainText(
      'has triggered alerts on telemetry readings and cannot be deleted; disable it instead',
    );
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(row).toBeVisible();
  });

  test('[DATA] an invalid CSV is rejected by line and stores nothing', async ({ request }) => {
    const csv = telemetryCsv([
      { turbineId: TURBINE, farmId: FARM, timestamp: '2026-01-02T23:57:00Z' },
      { turbineId: TURBINE, farmId: FARM, timestamp: 'not-a-time' },
    ]);
    const response = await request.post(`${INGESTION_URL}/ingest/telemetry`, {
      multipart: { file: { name: 'bad.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) } },
    });
    expect(response.status()).toBe(400);
    const body = (await response.json()) as { errors: { line: number; errors: string[] }[] };
    expect(body.errors.map((e) => e.line)).toEqual([3]);
    // All or nothing: the valid row was not stored either.
    const token = await apiToken(request, 'viewer');
    expect(
      await turbineTelemetry(
        request,
        token,
        TURBINE,
        '2026-01-02T23:57:00Z',
        '2026-01-02T23:58:00Z',
      ),
    ).toEqual([]);
  });
});
