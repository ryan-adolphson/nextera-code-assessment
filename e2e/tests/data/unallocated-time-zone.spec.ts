import { expect, test, type Page } from '@playwright/test';
import { fixBrowserDate, shortTimeIn } from '../support/clock.js';
import { mainNav } from '../support/fleet.js';
import { API_URL, SEED_NOW, apiToken, logIn } from '../support/session.js';
import { uploadTelemetry } from '../support/telemetry.js';
import { removeUnallocated } from '../support/unallocated.js';

/**
 * [DATA] Unallocated times follow Settings → Time zone (plan 12.6, was not automated): a browser
 * in America/Chicago, the clock fixed with fixBrowserDate (page.clock would break the app's
 * TZDate/UTCDate formatting, see support/clock.ts). One held entry per run (`E2E-<run>-TZ` on
 * FARM01, readings Jan 2 23:50/23:55 UTC); first/last seen and blocked at are server times, so the
 * expectations are derived from the API's entry. afterAll removes the entry (block → unblock).
 */

test.use({ timezoneId: 'America/Chicago' });

const ZONE = 'America/Chicago';
/** New per run (and per repetition: set in beforeAll). */
let TURBINE = '';

interface Entry {
  id: string;
  turbineId: string;
  firstSeenAt: string;
  lastSeenAt: string;
  blockedAt: string | null;
}

async function entryOf(page: Page, status: 'pending' | 'blocked'): Promise<Entry> {
  const response = await page.request.get(`${API_URL}/unallocated-turbines`, {
    params: { status },
    headers: { Authorization: `Bearer ${await apiToken(page.request, 'owner')}` },
  });
  const entry = ((await response.json()) as Entry[]).find((e) => e.turbineId === TURBINE);
  expect(entry, `${TURBINE} is ${status}`).toBeTruthy();
  return entry!;
}

async function chooseZone(page: Page, mode: 'UTC' | 'Local'): Promise<void> {
  await mainNav(page).getByRole('link', { name: 'Settings' }).click();
  const radio = page
    .getByTestId('time-zone')
    .getByRole('radio', { name: mode === 'UTC' ? 'UTC' : /^Local/, exact: mode === 'UTC' });
  await radio.click();
  await expect(radio).toHaveAttribute('aria-checked', 'true');
}

test.describe('[DATA] Unallocated times in the chosen zone (browser in America/Chicago)', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ request }) => {
    TURBINE = `E2E-${Date.now().toString(36).toUpperCase()}-TZ`;
    expect(
      await uploadTelemetry(request, [
        { turbineId: TURBINE, farmId: 'FARM01', timestamp: '2026-01-02T23:50:00Z' },
        { turbineId: TURBINE, farmId: 'FARM01', timestamp: '2026-01-02T23:55:00Z' },
      ]),
    ).toMatchObject({ held: 2 });
  });

  test.afterAll(async ({ request }) => {
    await removeUnallocated(
      request,
      await apiToken(request, 'owner'),
      (e) => e.turbineId === TURBINE,
    );
  });

  test('[DATA] Pending: seen times and held readings switch between UTC and Chicago time', async ({
    page,
  }) => {
    await fixBrowserDate(page, SEED_NOW);
    await page.route('**/api/events**', (route) => route.abort());
    await logIn(page, 'owner');
    const entry = await entryOf(page, 'pending');
    const row = page.locator(`[data-testid="unallocated-row"][data-turbine-id="${TURBINE}"]`);
    const table = page.getByTestId('unallocated');

    for (const [mode, zone, tag] of [
      ['Local', ZONE, 'local'],
      ['UTC', 'UTC', 'UTC'],
    ] as const) {
      await chooseZone(page, mode);
      await mainNav(page).getByRole('link', { name: 'Unallocated' }).click();
      await expect(table.getByRole('columnheader', { name: `Seen (${tag})` })).toBeVisible();
      await expect(row.getByTestId('last-seen')).toHaveText(
        `Last ${shortTimeIn(entry.lastSeenAt, zone)}`,
      );
      await expect(row.getByTestId('first-seen')).toHaveText(
        `First ${shortTimeIn(entry.firstSeenAt, zone)}`,
      );

      await row.getByRole('button', { name: `Show held readings for ${TURBINE}` }).click();
      const held = page.getByRole('table', { name: `Held readings for ${TURBINE}` });
      await expect(held.getByRole('columnheader', { name: `Measured (${tag})` })).toBeVisible();
      await expect(held.getByTestId('held-reading').first()).toContainText(
        shortTimeIn('2026-01-02T23:55:00Z', zone), // Jan 2, 17:55 in Chicago
      );
    }
  });

  test('[DATA] Blocked: the blocked time is shown in Chicago time under Local', async ({
    page,
  }) => {
    await fixBrowserDate(page, SEED_NOW);
    await page.route('**/api/events**', (route) => route.abort());
    await logIn(page, 'owner');
    const pending = await entryOf(page, 'pending');
    const blocked = await page.request.post(`${API_URL}/unallocated-turbines/${pending.id}/block`, {
      headers: { Authorization: `Bearer ${await apiToken(page.request, 'owner')}` },
    });
    expect(blocked.status()).toBe(200);
    const entry = await entryOf(page, 'blocked');

    await chooseZone(page, 'Local');
    await page.goto('/unallocated/blocked');
    const row = page.locator(`[data-testid="blocked-row"][data-turbine-id="${TURBINE}"]`);
    await expect(
      page.getByTestId('blocked').getByRole('columnheader', { name: 'Blocked (local)' }),
    ).toBeVisible();
    await expect(row.getByTestId('blocked-at')).toHaveText(shortTimeIn(entry.blockedAt!, ZONE));
  });
});
