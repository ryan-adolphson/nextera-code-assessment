import { expect, test, type Page } from '@playwright/test';
import {
  farmsFrom,
  farmsResponse,
  mainNav,
  turbinesOf,
  type FleetTurbine,
} from '../support/fleet.js';
import { SEED_NOW, logIn } from '../support/session.js';

// Plan 5.2–5.3: staleness follows the client clock (FleetStore ticks every minute) across the
// 15/30/60-minute boundaries. page.clock is installed before the page opens and, once the page has
// rendered GET /api/farms, moved relative to TURB001's latest reading there (Jan 2 23:55 with the
// fixture; a later demo reading locally). Live stream aborted, so no reading arrives mid-test.
// Read-only.
//
// The clock only ever moves forward (tickAt). Moving it back while Leaflet animates makes the test
// time out: its pan and tile-fade loops compare `+new Date()` with a start time now in the future,
// so they request a frame every 16 fake ms until the clock catches up, and runFor spends 30+ real
// seconds on them.

const MIN = 60_000;

/** Before TURB001's latest reading on any seeded database, so every tickAt is a forward move. */
const CLOCK_START = new Date(SEED_NOW.getTime() - 60 * MIN);

async function setup(page: Page): Promise<{ latest: number; turbines: FleetTurbine[] }> {
  await page.clock.install({ time: CLOCK_START });
  await page.route('**/api/events**', (route) => route.abort());
  const farms = farmsResponse(page);
  await logIn(page, 'viewer');
  const turbines = turbinesOf(await farmsFrom(farms));
  const latest = turbines.find((t) => t.id === 'TURB001')?.latest;
  expect(latest, 'TURB001 has readings (npm run db:seed)').toBeTruthy();
  return { latest: Date.parse(latest!.timestamp), turbines };
}

/**
 * Jumps the clock to `at`, firing each due timer once: the store's minute tick reads exactly `at`.
 * pauseAt fails rather than move back. resume is required: Angular's scheduler runs on the faked
 * setTimeout and requestAnimationFrame, so a paused clock would never render the new time.
 */
async function tickAt(page: Page, at: number): Promise<void> {
  await page.clock.pauseAt(at);
  await page.clock.resume();
}

/** Reporting at client time `at`: latest reading at most 15 min old (or ahead of the clock). */
const reportingAt = (turbines: FleetTurbine[], at: number) =>
  turbines.filter((t) => !!t.latest && at - Date.parse(t.latest.timestamp) <= 15 * MIN).length;

test.describe('Staleness', () => {
  test('the Turbines pill goes Reporting → 15 → 30 → 60 min exactly after each boundary', async ({
    page,
  }) => {
    const { latest } = await setup(page);
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
    const { latest, turbines } = await setup(page);
    const reporting = page.getByTestId('fleet-reporting');
    const countAt = async (at: number) => {
      await tickAt(page, at);
      const count = reportingAt(turbines, at);
      await expect(reporting).toHaveText(`${count} / ${turbines.length}`);
      return count;
    };

    // TURB001 reports at 5 min and is stale at 40, so the count has to drop by at least that one.
    const before = await countAt(latest + 5 * MIN);
    const after = await countAt(latest + 40 * MIN);
    expect(after).toBeLessThan(before);

    await page.getByRole('link', { name: 'Prairie Ridge' }).first().click();
    await page.getByTestId('turbines').getByRole('link', { name: 'TURB001', exact: true }).click();
    await expect(page.getByTestId('status')).toContainText('No data in 30 min');
  });
});
