import { expect, test, type Page } from '@playwright/test';
import { farmsFrom, farmsResponse, mainNav, turbinesOf } from '../support/fleet.js';
import { SEED_NOW, logIn } from '../support/session.js';

// Plan 5.2–5.3: staleness follows the client clock (FleetStore ticks every minute) across the
// 15/30/60-minute boundaries. The clock is installed (page.clock: timers run only when told) and,
// once the page has rendered GET /api/farms, set relative to TURB001's latest reading there
// (Jan 2 23:55 with the fixture; a later demo reading locally). Live stream aborted, so no reading
// arrives mid-test. Read-only.

const MIN = 60_000;

async function setup(page: Page): Promise<number> {
  await page.clock.install({ time: SEED_NOW });
  await page.route('**/api/events**', (route) => route.abort());
  const farms = farmsResponse(page);
  await logIn(page, 'viewer');
  const latest = turbinesOf(await farmsFrom(farms)).find((t) => t.id === 'TURB001')?.latest;
  expect(latest, 'TURB001 has readings (npm run db:seed)').toBeTruthy();
  return Date.parse(latest!.timestamp);
}

/** Moves the clock to `at` and lets the minute tick run, so the store reads the new time. */
async function tickAt(page: Page, at: number): Promise<void> {
  await page.clock.setSystemTime(at - MIN);
  await page.clock.runFor(MIN);
}

test.describe('Staleness', () => {
  test('the Turbines pill goes Reporting → 15 → 30 → 60 min exactly after each boundary', async ({
    page,
  }) => {
    const latest = await setup(page);
    await mainNav(page).getByRole('link', { name: 'Turbines' }).click();
    await page.getByRole('searchbox', { name: 'Turbine or farm' }).fill('TURB001');
    const pill = page.locator('tr[data-turbine-id="TURB001"]').getByRole('cell').nth(2);

    for (const [age, label] of [
      [15 * MIN, 'Reporting'], // exactly 15:00 old still counts as reporting
      [16 * MIN, 'No data in 15 min'],
      [30 * MIN, 'No data in 15 min'],
      [31 * MIN, 'No data in 30 min'],
      [60 * MIN, 'No data in 30 min'],
      [61 * MIN, 'No data in 60 min'],
    ] as const) {
      await tickAt(page, latest + age);
      await expect(pill, `${age / MIN} min old`).toHaveText(label);
    }
    // The status filter finds it under its new level.
    await page.getByTestId('status-filter').selectOption({ label: 'No data in 60 min' });
    await expect(page.locator('tr[data-turbine-id="TURB001"]')).toHaveCount(1);
  });

  test('the turbine page pill and the overview count follow the clock', async ({ page }) => {
    const latest = await setup(page);
    const reporting = page.getByTestId('fleet-reporting');
    await tickAt(page, latest + 5 * MIN);
    const before = Number(/(\d+) \//.exec((await reporting.textContent()) ?? '')![1]);

    // Only TURB001's latest is known here; every turbine with an older-or-equal latest also goes
    // stale, so the count can only drop (by at least TURB001).
    await tickAt(page, latest + 40 * MIN);
    await expect
      .poll(async () => Number(/(\d+) \//.exec((await reporting.textContent()) ?? '')![1]))
      .toBeLessThan(before);

    await page.getByRole('link', { name: 'Prairie Ridge' }).first().click();
    await page.getByTestId('turbines').getByRole('link', { name: 'TURB001', exact: true }).click();
    await expect(page.getByTestId('status')).toContainText('No data in 30 min');
  });
});
