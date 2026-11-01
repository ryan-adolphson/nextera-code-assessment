import { expect, test, type Page } from '@playwright/test';
import {
  farmsFrom,
  farmsResponse,
  mainNav,
  turbinesOf,
  type FleetFarm,
  type FleetTurbine,
} from '../support/fleet.js';
import { SEED_NOW, logIn } from '../support/session.js';

// Plan 4: /turbines — filters (text, status, commissioning), sorting and paging. Sorting and
// filtering run on the real GET /api/farms (expectations from the response the page rendered);
// paging needs more than 25 turbines, which the fixture doesn't have, so that test serves a
// generated fleet (page.route). Read-only; live stream aborted.

type Staleness =
  'Reporting' | 'No data in 15 min' | 'No data in 30 min' | 'No data in 60 min' | 'No readings yet';

/** The status pill at the fixed browser clock (staleness.ts: strictly more than 15/30/60 min). */
function status(t: FleetTurbine): Staleness {
  if (!t.latest) return 'No readings yet';
  const age = SEED_NOW.getTime() - Date.parse(t.latest.timestamp);
  return age > 3_600_000
    ? 'No data in 60 min'
    : age > 1_800_000
      ? 'No data in 30 min'
      : age > 900_000
        ? 'No data in 15 min'
        : 'Reporting';
}

async function openTurbines(page: Page): Promise<(FleetTurbine & { farm: FleetFarm })[]> {
  await page.clock.setFixedTime(SEED_NOW);
  await page.route('**/api/events**', (route) => route.abort());
  const farms = farmsResponse(page);
  await logIn(page, 'viewer');
  const turbines = turbinesOf(await farmsFrom(farms));
  await mainNav(page).getByRole('link', { name: 'Turbines' }).click();
  await expect(page).toHaveURL(/\/turbines$/);
  return turbines;
}

const rows = (page: Page) => page.getByTestId('turbines').locator('tr[data-turbine-id]');
const shownIds = (page: Page) =>
  rows(page).evaluateAll((els) => els.map((e) => e.getAttribute('data-turbine-id')!));
const count = (page: Page) => page.getByTestId('turbine-count');
const search = (page: Page) => page.getByRole('searchbox', { name: 'Turbine or farm' });
const byId = (a: string, b: string) => a.localeCompare(b);

test.describe('Turbines table', () => {
  test('lists every turbine by id with its columns and the match count', async ({ page }) => {
    const turbines = await openTurbines(page);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Turbines');
    await expect(page.getByTestId('turbines').getByRole('columnheader')).toHaveText([
      'Turbine',
      'Farm',
      'Status',
      'Commissioned',
      'Power (kW)',
      'Wind (m/s)',
      'Gearbox (°C)',
      'Last reading (UTC)',
    ]);
    await expect(count(page)).toHaveText(`${turbines.length} of ${turbines.length} turbines`);
    await expect(page.getByTestId('sort-id')).toHaveAttribute('aria-sort', 'ascending');
    await expect
      .poll(() => shownIds(page))
      .toEqual(
        turbines
          .map((t) => t.id)
          .sort(byId)
          .slice(0, 25),
      );

    await search(page).fill('TURB001');
    const turb001 = page.locator('tr[data-turbine-id="TURB001"]');
    const t1 = turbines.find((t) => t.id === 'TURB001')!;
    await expect(turb001.getByRole('cell').nth(1)).toHaveText('Prairie Ridge FARM01');
    await expect(turb001.getByRole('cell').nth(2)).toHaveText(status(t1));
    await expect(turb001.getByTestId('commissioned-icon')).toHaveAttribute(
      'data-icon',
      t1.commissioned ? 'check' : 'x',
    );
  });

  test('the text filter matches turbine ids and farm names, case-insensitively; Clear resets it', async ({
    page,
  }) => {
    const turbines = await openTurbines(page);
    await search(page).fill('turb002');
    await expect.poll(() => shownIds(page)).toEqual(['TURB002']);
    await expect(count(page)).toHaveText(`1 of ${turbines.length} turbines`);

    await search(page).fill('prairie');
    const prairie = turbines.filter((t) => t.farm.name === 'Prairie Ridge');
    await expect(count(page)).toHaveText(`${prairie.length} of ${turbines.length} turbines`);
    await expect(rows(page)).toHaveCount(Math.min(prairie.length, 25));
    for (const farm of await rows(page).getByRole('cell').nth(1).allTextContents())
      expect(farm).toContain('Prairie Ridge');

    await search(page).fill('zzzz');
    await expect(page.getByTestId('no-matches')).toHaveText('No turbines match the filters.');
    await expect(count(page)).toHaveText(`0 of ${turbines.length} turbines`);

    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(search(page)).toHaveValue('');
    await expect(search(page)).toBeFocused();
    await expect(count(page)).toHaveText(`${turbines.length} of ${turbines.length} turbines`);
    await expect(page.getByRole('button', { name: 'Clear search' })).toHaveCount(0);
  });

  test('the status filter keeps only turbines with that pill', async ({ page }) => {
    const turbines = await openTurbines(page);
    const statusFilter = page.getByTestId('status-filter');
    for (const label of ['Reporting', 'No data in 60 min', 'No readings yet'] as const) {
      await statusFilter.selectOption({ label });
      const expected = turbines.filter((t) => status(t) === label);
      await expect(count(page)).toHaveText(`${expected.length} of ${turbines.length} turbines`);
      if (expected.length) {
        for (const pill of await rows(page).getByRole('cell').nth(2).allTextContents())
          expect(pill.trim()).toBe(label);
      } else {
        await expect(page.getByTestId('no-matches')).toBeVisible();
      }
    }
    await statusFilter.selectOption({ label: 'All statuses' });
    await expect(count(page)).toHaveText(`${turbines.length} of ${turbines.length} turbines`);
  });

  test('the commissioning filter shows only check marks or only crosses, and ANDs with the text', async ({
    page,
  }) => {
    const turbines = await openTurbines(page);
    const filter = page.getByTestId('commissioned-filter');
    for (const [label, commissioned, icon] of [
      ['Not commissioned', false, 'x'],
      ['Commissioned', true, 'check'],
    ] as const) {
      await filter.selectOption({ label });
      const expected = turbines.filter((t) => t.commissioned === commissioned);
      await expect(count(page)).toHaveText(`${expected.length} of ${turbines.length} turbines`);
      const icons = await rows(page)
        .getByTestId('commissioned-icon')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-icon')));
      expect(new Set(icons)).toEqual(new Set(expected.length ? [icon] : []));
    }

    await filter.selectOption({ label: 'Not commissioned' });
    await search(page).fill('TURB001');
    const both = turbines.filter((t) => !t.commissioned && t.id.toLowerCase().includes('turb001'));
    await expect(count(page)).toHaveText(`${both.length} of ${turbines.length} turbines`);
    await filter.selectOption({ label: 'Any' });
    await expect(count(page)).toHaveText(
      `${turbines.filter((t) => t.id.toLowerCase().includes('turb001')).length} of ${turbines.length} turbines`,
    );
  });

  test('a column header sorts by it; clicking again reverses', async ({ page }) => {
    const turbines = await openTurbines(page);
    const withReadings = turbines.filter((t) => t.latest);

    await page.getByTestId('sort-id').click();
    await expect(page.getByTestId('sort-id')).toHaveAttribute('aria-sort', 'descending');
    await expect
      .poll(() => shownIds(page))
      .toEqual(
        turbines
          .map((t) => t.id)
          .sort(byId)
          .reverse()
          .slice(0, 25),
      );

    await page.getByTestId('sort-farm').click();
    await expect(page.getByTestId('sort-farm')).toHaveAttribute('aria-sort', 'ascending');
    const farmOrder = await rows(page).evaluateAll((els) =>
      els.map((e) => e.querySelectorAll('td')[1].querySelector('a')!.textContent!.trim()),
    );
    expect(farmOrder).toEqual([...farmOrder].sort(byId));

    await page.getByTestId('sort-power').click();
    await page.getByTestId('sort-power').click();
    await expect(page.getByTestId('sort-power')).toHaveAttribute('aria-sort', 'descending');
    const top = [...withReadings].sort(
      (a, b) => b.latest!.powerOutputKw - a.latest!.powerOutputKw || a.id.localeCompare(b.id),
    )[0];
    await expect(rows(page).first()).toHaveAttribute('data-turbine-id', top.id);
  });

  test('a turbine link opens its page', async ({ page }) => {
    await openTurbines(page);
    await search(page).fill('TURB002');
    await page
      .locator('tr[data-turbine-id="TURB002"]')
      .getByRole('link', { name: 'TURB002' })
      .click();
    await expect(page).toHaveURL(/\/farms\/FARM02\/turbines\/TURB002$/);
    await expect(page.getByRole('heading', { level: 1 })).toContainText('TURB002');
  });

  test('pages through 60 turbines; page size and filters return to the first page', async ({
    page,
  }) => {
    // A generated fleet: the fixture has 2 turbines (paging needs more than 25).
    const fleet: FleetFarm[] = [
      {
        id: 'FARM01',
        name: 'Prairie Ridge',
        turbines: Array.from({ length: 60 }, (_, i) => ({
          id: `GEN${String(i + 1).padStart(3, '0')}`,
          commissioned: i % 2 === 0,
          latest: {
            turbineId: `GEN${String(i + 1).padStart(3, '0')}`,
            farmId: 'FARM01',
            timestamp: '2026-01-02T23:55:00.000Z',
            powerOutputKw: 1000 + i,
            windSpeedMs: 8,
            gearboxTempC: 70,
          },
        })),
      },
    ];
    await page.route(
      (url) => url.pathname.endsWith('/api/farms'),
      async (route) => {
        const real = (await (await route.fetch()).json()) as Record<string, unknown>[];
        // The farm's other fields (location, …) from the real API, the turbines generated.
        await route.fulfill({ json: [{ ...real.find((f) => f.id === 'FARM01'), ...fleet[0] }] });
      },
    );
    await openTurbines(page);
    const paginator = page.getByTestId('turbines-paginator');
    await expect(paginator).toContainText('1 – 25 of 60');
    await expect(paginator.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await expect(rows(page).first()).toHaveAttribute('data-turbine-id', 'GEN001');

    await paginator.getByRole('button', { name: 'Next page' }).click();
    await expect(paginator).toContainText('26 – 50 of 60');
    await expect(rows(page).first()).toHaveAttribute('data-turbine-id', 'GEN026');
    await expect(paginator.getByRole('button', { name: 'Previous page' })).toBeEnabled();

    // Keyboard: Material's touch target covers the select for pointer clicks.
    await paginator.getByRole('combobox', { name: 'Items per page:' }).press('Enter');
    await page.getByRole('option', { name: '10', exact: true }).click();
    // Material keeps the first row of the page in view: GEN026 is on 21 – 30.
    await expect(paginator).toContainText('21 – 30 of 60');
    await expect(rows(page)).toHaveCount(10);
    await expect(rows(page).first()).toHaveAttribute('data-turbine-id', 'GEN021');

    await page.getByTestId('commissioned-filter').selectOption({ label: 'Commissioned' });
    await expect(paginator).toContainText('1 – 10 of 30');
    await expect(rows(page).first()).toHaveAttribute('data-turbine-id', 'GEN001');
  });
});
