import { expect, test, type Page } from '@playwright/test';
import { farmsFrom, farmsResponse, type FleetFarm, type FleetTurbine } from '../support/fleet.js';
import { SEED_NOW, logIn } from '../support/session.js';

// Plan 3.1–3.4: the fleet overview (tiles, Leaflet map, farm table) and a farm page, against
// the real GET /api/farms (expectations derived from the response the page rendered: the
// fixture in CI; demo data and earlier runs' turbines locally). Read-only; live stream aborted.

/** Reporting at the browser clock: latest reading at most 15 min old (or ahead of the clock). */
const reporting = (t: FleetTurbine) =>
  !!t.latest && SEED_NOW.getTime() - Date.parse(t.latest.timestamp) <= 15 * 60_000;

async function openOverview(page: Page): Promise<FleetFarm[]> {
  await page.clock.setFixedTime(SEED_NOW);
  await page.route('**/api/events**', (route) => route.abort());
  const farms = farmsResponse(page);
  await logIn(page, 'viewer');
  return farmsFrom(farms);
}

test.describe('Fleet overview', () => {
  test('tiles and the farm table sum up GET /api/farms', async ({ page }) => {
    const farms = await openOverview(page);
    const turbines = farms.flatMap((f) => f.turbines);

    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Fleet overview');
    const summary = page.getByRole('region', { name: 'Fleet summary' });
    await expect(summary.getByTestId('fleet-reporting')).toContainText(
      `${turbines.filter(reporting).length} / ${turbines.length}`,
    );
    await expect(summary).toContainText(`Wind farms${farms.length}`);
    const powerMw =
      turbines.filter(reporting).reduce((sum, t) => sum + t.latest!.powerOutputKw, 0) / 1000;
    await expect(summary.getByTestId('fleet-power')).toContainText(
      `${powerMw.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MW`,
    );

    const table = page.getByTestId('farms');
    await expect(table.getByRole('columnheader')).toHaveText([
      'Farm',
      'Location',
      'Turbines',
      'Reporting',
      'Output (kW)',
      'Avg wind (m/s)',
    ]);
    const rows = table.getByRole('row');
    await expect(rows).toHaveCount(farms.length + 1);
    for (const [i, farm] of farms.entries()) {
      const cells = rows.nth(i + 1).getByRole('cell');
      await expect(cells.nth(0)).toHaveText(`${farm.name} ${farm.id}`);
      await expect(cells.nth(2)).toHaveText(String(farm.turbines.length));
      await expect(cells.nth(3)).toHaveText(
        farm.turbines.length ? String(farm.turbines.filter(reporting).length) : '–',
      );
    }
    // Every farm is on the map, so the table has no paginator.
    await expect(page.locator('mat-paginator')).toHaveCount(0);
  });

  test('the map draws one marker per farm with the legend; a marker opens its farm', async ({
    page,
  }) => {
    const farms = await openOverview(page);
    const map = page.getByRole('region', { name: 'Map of wind farms' });
    await map.scrollIntoViewIfNeeded();
    const markers = page.locator('[data-marker-id]');
    await expect(markers).toHaveCount(farms.length);
    await expect(page.getByTestId('legend')).toContainText('Reporting');
    await expect(page.getByTestId('legend')).toContainText('No data in 60 min');
    await expect(page.getByRole('button', { name: 'Zoom in' })).toBeVisible();

    // A real click on the vector marker (Leaflet hit-tests the SVG path; layout needed).
    await page.locator('[data-marker-id="FARM02"]').click();
    await expect(page).toHaveURL(/\/farms\/FARM02$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('High Plains');
  });

  test('a farm row opens the farm page; All farms goes back', async ({ page }) => {
    await openOverview(page);
    await page
      .getByTestId('farms')
      .getByRole('row')
      .filter({ hasText: 'FARM01' })
      .getByRole('cell')
      .nth(2)
      .click();
    await expect(page).toHaveURL(/\/farms\/FARM01$/);
    await expect(page).toHaveTitle(/Prairie Ridge · Nextera|Farm · Nextera/);
    await page.getByTestId('back-to-farms').click();
    await expect(page).toHaveURL(/\/farms$/);
  });
});

test.describe('Farm page', () => {
  test("lists the farm's turbines without a Farm column, with a marker each", async ({ page }) => {
    const farms = await openOverview(page);
    const farm = farms.find((f) => f.id === 'FARM02')!;
    await page.getByTestId('farms').getByRole('link', { name: farm.name }).click();
    await expect(page).toHaveURL(/\/farms\/FARM02$/);

    await expect(page.getByTestId('farm-reporting')).toContainText(
      `${farm.turbines.filter(reporting).length} / ${farm.turbines.length}`,
    );
    await expect(page.getByTestId('turbine-count')).toHaveText(
      `${farm.turbines.length} of ${farm.turbines.length} turbines`,
    );
    await expect(page.getByTestId('sort-farm')).toHaveCount(0);
    // Without the Farm column the filter searches turbine ids only.
    await expect(page.getByRole('searchbox', { name: 'Turbine', exact: true })).toBeVisible();
    const ids = farm.turbines.map((t) => t.id).sort((a, b) => a.localeCompare(b));
    await expect(page.getByTestId('turbines').locator('tr[data-turbine-id]')).toHaveCount(
      Math.min(ids.length, 25),
    );

    await page
      .getByRole('region', { name: `Map of turbines at ${farm.name}` })
      .scrollIntoViewIfNeeded();
    await expect(page.locator('[data-marker-id]')).toHaveCount(farm.turbines.length);
  });

  test('a farm without turbines says so', async ({ page }) => {
    // The fixture has eight farms without turbines; with db:seed:demo every farm has some, so then
    // the real response is passed on with the last farm's turbines removed.
    await page.route(
      (url) => url.pathname.endsWith('/api/farms'),
      async (route) => {
        const farms = (await (await route.fetch()).json()) as FleetFarm[];
        if (!farms.some((f) => f.turbines.length === 0)) farms.at(-1)!.turbines = [];
        await route.fulfill({ json: farms });
      },
    );
    const farms = await openOverview(page);
    const empty = farms.find((f) => f.turbines.length === 0)!;
    await page.getByTestId('farms').getByRole('link', { name: empty.name }).click();
    await expect(page).toHaveURL(new RegExp(`/farms/${empty.id}$`));
    await expect(page.getByTestId('no-turbines')).toHaveText(
      'No turbines are registered for this farm yet.',
    );
    await expect(page.getByTestId('turbines')).toHaveCount(0);
    await expect(page.getByTestId('farm-reporting')).toContainText('0 / 0');
  });
});
