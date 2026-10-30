import { expect, test, type Page } from '@playwright/test';
import { API_URL, apiToken, signIn } from '../support/session.js';
import { turbineTelemetry, uploadTelemetry } from '../support/telemetry.js';
import { listUnallocated, removeUnallocated, type UnallocatedEntry } from '../support/unallocated.js';

/**
 * [DATA] Unallocated turbines (plan section 11): readings of unknown turbines and farm mismatches
 * uploaded through the ingestion worker's CSV endpoint are held, show up live under
 * /unallocated/pending, and an owner assigns, keeps, blocks and unblocks them.
 *
 * Re-runnable on the same database:
 * - Unknown turbine ids are unique per run (`E2E-<run>-…`; the ingestion DTO allows 1–64
 *   characters of free text), so a held id never collides with a turbine an earlier run created.
 * - The farm mismatch uses TURB001 reporting FARM02 at a unique timestamp in 2020, so Keep always
 *   imports exactly one new reading, far outside every window the app shows for the Jan 2026
 *   fixture.
 * - afterAll removes every entry these tests held (block deletes the held readings, unblock the
 *   entry), also when a test failed half-way.
 *
 * Left behind, because there is no turbine or telemetry delete API: two turbines per run
 * (`E2E-<run>-NEW` on FARM01 and `E2E-<run>-MOV` on FARM03, not commissioned, each with 2 readings
 * on Jan 2 23:50–23:55) and one TURB001 reading per run in 2020. A fresh `docker compose down -v` + `db:seed` clears them.
 *
 * Timestamps: ingestion checks them against the real server clock (not in the future, from
 * 2000-01-01), while the browser clock is fixed at SEED_NOW (2026-01-03T00:00Z). Readings of the
 * unknown turbines are on Jan 2 23:45–23:55, so the UI shows them as "Reporting".
 */

const RUN = Date.now().toString(36).toUpperCase();
const id = (suffix: string) => `E2E-${RUN}-${suffix}`;
const ours = (entry: UnallocatedEntry) =>
  entry.turbineId.startsWith(`E2E-${RUN}-`) ||
  (entry.turbineId === 'TURB001' && entry.reportedFarmId === 'FARM02');

/** A unique, whole-second measurement time in 2020 for this run. */
const MISMATCH_AT = new Date(
  Date.UTC(2020, 0, 1) + Math.floor((Date.now() % (365 * 86_400_000)) / 1000) * 1000,
).toISOString();

function pendingRow(page: Page, turbineId: string) {
  return page.locator(`[data-testid="unallocated-row"][data-turbine-id="${turbineId}"]`);
}

/** Signs in as the owner and opens Unallocated from the side nav; waits for the list and Live. */
async function openPending(page: Page): Promise<void> {
  await signIn(page, 'owner');
  const listed = page.waitForResponse(
    (r) => r.url().includes('/api/unallocated-turbines?status=pending') && r.ok(),
  );
  await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Unallocated' }).click();
  await expect(page).toHaveURL(/\/unallocated\/pending$/);
  await listed;
  await expect(page.getByTestId('live-status')).toHaveText('Live');
}

test.describe('[DATA] Unallocated turbines', () => {
  test.beforeAll(async ({ request }) => {
    // A TURB001/FARM02 entry left by an interrupted earlier run would add its readings to Keep.
    await removeUnallocated(request, await apiToken(request, 'owner'), ours);
  });

  test.afterAll(async ({ request }) => {
    const token = await apiToken(request, 'owner');
    await removeUnallocated(request, token, ours);
    const left = [
      ...(await listUnallocated(request, token, 'pending')),
      ...(await listUnallocated(request, token, 'blocked')),
    ].filter(ours);
    expect(left, 'entries left behind').toEqual([]);
  });

  test('[DATA] an unknown turbine appears under Pending live and expands to its held readings', async ({
    page,
    request,
  }) => {
    const turbineId = id('LIVE');
    await openPending(page);
    await expect(pendingRow(page, turbineId)).toHaveCount(0);
    // Marks this document: it must survive until the row appears (no reload, only SSE).
    await page.evaluate(() => ((window as { e2eNoReload?: boolean }).e2eNoReload = true));

    const result = await uploadTelemetry(request, [
      { turbineId, farmId: 'FARM01', timestamp: '2026-01-02T23:45:00Z', powerOutputKw: 1400 },
      { turbineId, farmId: 'FARM01', timestamp: '2026-01-02T23:50:00Z', powerOutputKw: 1450 },
      {
        turbineId,
        farmId: 'FARM01',
        timestamp: '2026-01-02T23:55:00Z',
        powerOutputKw: 1520,
        windSpeedMs: 8.2,
        gearboxTempC: 71.5,
      },
    ]);
    expect(result).toMatchObject({ rows: 3, inserted: 0, held: 3, blocked: 0 });

    const row = pendingRow(page, turbineId);
    await expect(row).toBeVisible();
    expect(await page.evaluate(() => (window as { e2eNoReload?: boolean }).e2eNoReload)).toBe(true);
    await expect(row.getByTestId('kind')).toHaveText('Unknown turbine');
    await expect(row.getByTestId('reported-farm')).toHaveText('Prairie Ridge (FARM01)');
    await expect(row.getByTestId('current-farm')).toHaveText('–');
    await expect(row.getByTestId('held')).toHaveText('3');
    await expect(row.getByTestId('latest')).toHaveText('1,520 kW · 8.2 m/s · 71.5 °C');
    // The newest held reading (23:55) is 5 min before the browser clock.
    await expect(row.getByTestId('staleness')).toHaveText('Reporting');
    await expect(row.getByRole('button', { name: `Assign ${turbineId} to farm…` })).toBeVisible();

    const expand = row.getByRole('button', { name: `Show held readings for ${turbineId}` });
    await expand.click();
    await expect(
      row.getByRole('button', { name: `Hide held readings for ${turbineId}` }),
    ).toHaveAttribute('aria-expanded', 'true');
    const held = page.getByRole('table', { name: `Held readings for ${turbineId}` });
    await expect(page.getByTestId('held-readings-count')).toHaveText(
      '3 held readings, newest first.',
    );
    const readings = held.getByTestId('held-reading');
    await expect(readings).toHaveCount(3);
    await expect(readings.nth(0)).toContainText('Jan 2, 23:55');
    await expect(readings.nth(0)).toContainText('1,520');
    await expect(readings.nth(2)).toContainText('Jan 2, 23:45');
    await expect(readings.nth(2)).toContainText('1,400');
  });

  test('[DATA] assigning an unknown turbine to FARM01 adds it to the fleet with its readings', async ({
    page,
    request,
  }) => {
    const turbineId = id('NEW');
    const result = await uploadTelemetry(request, [
      { turbineId, farmId: 'FARM01', timestamp: '2026-01-02T23:50:00Z', powerOutputKw: 1610 },
      { turbineId, farmId: 'FARM01', timestamp: '2026-01-02T23:55:00Z', powerOutputKw: 1640 },
    ]);
    expect(result).toMatchObject({ held: 2, inserted: 0 });

    await openPending(page);
    const row = pendingRow(page, turbineId);
    await row.getByRole('button', { name: `Assign ${turbineId} to farm…` }).click();

    const dialog = page.getByRole('dialog', { name: `Assign ${turbineId} to a farm` });
    await expect(dialog).toBeVisible();
    // The reported farm exists, so it is preselected.
    await expect(dialog.getByLabel('Farm')).toHaveValue('Prairie Ridge (FARM01)');
    await dialog.getByRole('button', { name: 'Assign', exact: true }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('unallocated-notice')).toHaveText(
      `${turbineId} assigned to Prairie Ridge (FARM01): 2 readings imported.`,
    );
    await expect(row).toHaveCount(0);

    // The shell's fleet now has the turbine, without reloading the app.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Turbines' }).click();
    await page.getByTestId('turbine-filter').fill(turbineId);
    const turbineRow = page.getByTestId('turbines').locator(`[data-turbine-id="${turbineId}"]`);
    await expect(turbineRow).toContainText('Prairie Ridge');
    await expect(turbineRow.getByTestId('staleness')).toHaveText('Reporting');
    await expect(turbineRow).toContainText('Jan 2, 23:55');
    await expect(turbineRow.getByTestId('commissioned-icon')).toHaveAttribute('data-icon', 'x');

    // Its imported readings are on the turbine page.
    await turbineRow.getByRole('link', { name: turbineId }).click();
    await expect(page).toHaveURL(new RegExp(`/farms/FARM01/turbines/${turbineId}$`));
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${turbineId} Prairie Ridge`);
    await expect(page.getByTestId('not-commissioned')).toBeVisible();
    const history = page.getByTestId('history');
    await expect(history.getByRole('row', { name: /Jan 2, 23:55/ })).toContainText('1,640.0');
    await expect(history.getByRole('row', { name: /Jan 2, 23:50/ })).toContainText('1,610.0');

    // And it is listed on its farm's page.
    await page.getByTestId('breadcrumb').getByRole('link', { name: 'Prairie Ridge' }).click();
    await expect(page).toHaveURL(/\/farms\/FARM01$/);
    await expect(
      page.getByTestId('turbines').locator(`[data-turbine-id="${turbineId}"]`),
    ).toBeVisible();
  });

  test('[DATA] Keep imports a farm mismatch under the turbine’s own farm', async ({
    page,
    request,
  }) => {
    const result = await uploadTelemetry(request, [
      { turbineId: 'TURB001', farmId: 'FARM02', timestamp: MISMATCH_AT, powerOutputKw: 1234.5 },
    ]);
    expect(result).toMatchObject({ held: 1, inserted: 0 });

    await openPending(page);
    const row = pendingRow(page, 'TURB001');
    await expect(row.getByTestId('kind')).toHaveText('Farm mismatch');
    await expect(row.getByTestId('reported-farm')).toHaveText('High Plains (FARM02)');
    await expect(row.getByTestId('current-farm')).toHaveText('Prairie Ridge (FARM01)');
    await expect(row.getByRole('button', { name: 'Move TURB001 to FARM02…' })).toBeEnabled();

    await row.getByRole('button', { name: 'Keep TURB001 in FARM01' }).click();
    await expect(page.getByTestId('unallocated-notice')).toHaveText(
      'TURB001 kept in Prairie Ridge (FARM01): 1 reading imported.',
    );
    await expect(row).toHaveCount(0);

    // The held reading is now TURB001's, under FARM01 (it is far outside the app's windows).
    const token = await apiToken(request, 'owner');
    const to = new Date(Date.parse(MISMATCH_AT) + 1000).toISOString();
    const stored = await turbineTelemetry(request, token, 'TURB001', MISMATCH_AT, to);
    expect(stored).toEqual([
      expect.objectContaining({ farmId: 'FARM01', timestamp: MISMATCH_AT, powerOutputKw: 1234.5 }),
    ]);
  });

  test('[DATA] Move takes a mismatched turbine and its history to the reported farm', async ({
    page,
    request,
  }) => {
    // A turbine of this run on FARM01 (held, then assigned through the API) that reports FARM03.
    const turbineId = id('MOV');
    const token = await apiToken(request, 'owner');
    await uploadTelemetry(request, [
      { turbineId, farmId: 'FARM01', timestamp: '2026-01-02T23:50:00Z', powerOutputKw: 900 },
    ]);
    const [held] = (await listUnallocated(request, token, 'pending')).filter(
      (e) => e.turbineId === turbineId,
    );
    const assigned = await request.post(`${API_URL}/unallocated-turbines/${held.id}/assign`, {
      data: { farmId: 'FARM01' },
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(assigned.status()).toBe(200);
    expect(
      await uploadTelemetry(request, [
        { turbineId, farmId: 'FARM03', timestamp: '2026-01-02T23:55:00Z', powerOutputKw: 950 },
      ]),
    ).toMatchObject({ held: 1, inserted: 0 });

    await openPending(page);
    const row = pendingRow(page, turbineId);
    await expect(row.getByTestId('kind')).toHaveText('Farm mismatch');
    await expect(row.getByTestId('current-farm')).toHaveText('Prairie Ridge (FARM01)');
    await row.getByRole('button', { name: `Move ${turbineId} to FARM03…` }).click();

    const dialog = page.getByRole('dialog', { name: `Move ${turbineId} to FARM03?` });
    await expect(dialog.getByTestId('confirm-text')).toContainText(
      `${turbineId} and all its readings will move to Red Canyon (FARM03)`,
    );
    await dialog.getByRole('button', { name: 'Move turbine' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('unallocated-notice')).toHaveText(
      `${turbineId} moved to Red Canyon (FARM03): 1 reading imported.`,
    );
    await expect(row).toHaveCount(0);

    // Its earlier FARM01 reading moved with it.
    const stored = await turbineTelemetry(
      request,
      token,
      turbineId,
      '2026-01-02T00:00:00Z',
      '2026-01-03T00:00:00Z',
    );
    expect(stored.map((r) => [r.timestamp, r.farmId])).toEqual([
      ['2026-01-02T23:55:00.000Z', 'FARM03'],
      ['2026-01-02T23:50:00.000Z', 'FARM03'],
    ]);

    // Without reload, the fleet has it on FARM03 and no longer on FARM01.
    await page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Turbines' }).click();
    await page.getByTestId('turbine-filter').fill(turbineId);
    const turbineRow = page.getByTestId('turbines').locator(`[data-turbine-id="${turbineId}"]`);
    await expect(turbineRow).toContainText('Red Canyon');
    await expect(turbineRow).toContainText('Jan 2, 23:55');
  });

  test('[DATA] a blocked turbine’s readings are dropped until it is unblocked', async ({
    page,
    request,
  }) => {
    const turbineId = id('BLK');
    expect(
      await uploadTelemetry(request, [
        { turbineId, farmId: 'FARM05', timestamp: '2026-01-02T22:00:00Z' },
      ]),
    ).toMatchObject({ held: 1, blocked: 0 });

    await openPending(page);
    const row = pendingRow(page, turbineId);
    // (The template leaves a space before the ellipsis: "Block <id> from FARM05 …".)
    await row.getByRole('button', { name: new RegExp(`^Block ${turbineId} from FARM05 ?…$`) }).click();
    const dialog = page.getByRole('dialog', { name: `Block ${turbineId} from FARM05?` });
    await expect(dialog.getByTestId('confirm-text')).toContainText(
      `Readings for ${turbineId} that report FARM05 will be dropped until you unblock it`,
    );
    await dialog.getByRole('button', { name: 'Block', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('unallocated-notice')).toHaveText(
      `Readings for ${turbineId} from FARM05 are now blocked.`,
    );
    await expect(row).toHaveCount(0);

    // A later reading of the blocked pair is dropped, not held.
    expect(
      await uploadTelemetry(request, [
        { turbineId, farmId: 'FARM05', timestamp: '2026-01-02T22:05:00Z' },
      ]),
    ).toMatchObject({ rows: 1, inserted: 0, held: 0, blocked: 1 });

    await page.getByTestId('unallocated-tabs').getByRole('link', { name: 'Blocked' }).click();
    await expect(page).toHaveURL(/\/unallocated\/blocked$/);
    const blocked = page.locator(`[data-testid="blocked-row"][data-turbine-id="${turbineId}"]`);
    await expect(blocked).toContainText('Blue Sky (FARM05)');
    await expect(blocked.getByTestId('kind')).toHaveText('Unknown turbine');
    await expect(blocked.getByTestId('blocked-by')).toHaveText('owner@nextera.local');
    await expect(blocked.getByTestId('blocked-at')).not.toHaveText('–');

    await blocked.getByRole('button', { name: `Unblock ${turbineId} from FARM05` }).click();
    await expect(page.getByTestId('unallocated-notice')).toHaveText(
      `${turbineId} from FARM05 unblocked: its next reading will show under Pending.`,
    );
    await expect(blocked).toHaveCount(0);

    // Unblock deletes the entry: nothing is left in either list.
    const token = await apiToken(request, 'owner');
    const all = [
      ...(await listUnallocated(request, token, 'pending')),
      ...(await listUnallocated(request, token, 'blocked')),
    ];
    expect(all.filter((e) => e.turbineId === turbineId)).toEqual([]);
  });
});
