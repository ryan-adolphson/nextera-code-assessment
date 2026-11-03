import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
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
// generated fleet (page.route), and the fixture has no never-reported turbine, so the "Hide turbines
// with no data" tests serve those through mockFleet. Read-only; live stream aborted.

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

async function openTurbines(
  page: Page,
  stream: (route: Route) => Promise<void> = (route) => route.abort(),
): Promise<(FleetTurbine & { farm: FleetFarm })[]> {
  await page.clock.setFixedTime(SEED_NOW);
  await page.route('**/api/events**', stream);
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
const hideNoData = (page: Page) =>
  page.getByRole('switch', { name: 'Hide turbines with no data' });

/** The table's order for Last reading: `dir` by time, ties by id (never-reported ones hidden). */
const byTime = (turbines: FleetTurbine[], dir: 'asc' | 'desc') =>
  turbines
    .filter((t) => t.latest)
    .sort((a, b) => {
      const order = a.latest!.timestamp.localeCompare(b.latest!.timestamp);
      return (dir === 'asc' ? order : -order) || byId(a.id, b.id);
    })
    .map((t) => t.id);

/** The count line for turbines matching the filters, with the switch on (the default). */
function countText(matching: FleetTurbine[], total: number): string {
  const hidden = matching.filter((t) => !t.latest).length;
  const shown = `${matching.length - hidden} of ${total} turbines`;
  return hidden ? `${shown} · ${hidden} with no data hidden` : shown;
}

const minutesAgo = (minutes: number) => new Date(SEED_NOW.getTime() - minutes * 60_000).toISOString();

/** A telemetry.received reading / GET /api/farms `latest` for a mocked turbine. */
const mockReading = (turbineId: string, farmId: string, ageMinutes: number, powerOutputKw: number) => ({
  id: `reading-${turbineId}`,
  turbineId,
  farmId,
  timestamp: minutesAgo(ageMinutes),
  receivedAt: minutesAgo(ageMinutes),
  powerOutputKw,
  windSpeedMs: 8,
  rotorRpm: 12,
  bladePitchDeg: 4,
  gearboxTempC: 70,
  alerts: [],
});

/** A mocked turbine: `ageMinutes` since its latest reading, or null if it has never reported. */
const mockTurbine = (id: string, farmId: string, ageMinutes: number | null, power = 1000) => ({
  id,
  farmId,
  latitude: 35.1,
  longitude: -101.2,
  commissioned: true,
  latest: ageMinutes === null ? null : mockReading(id, farmId, ageMinutes, power),
});

/** Serves GET /api/farms with the real farms, but only these turbines in them. */
async function mockFleet(page: Page, turbines: ReturnType<typeof mockTurbine>[]): Promise<void> {
  await page.route(
    (url) => url.pathname.endsWith('/api/farms'),
    async (route) => {
      const real = (await (await route.fetch()).json()) as FleetFarm[];
      await route.fulfill({
        json: real.map((farm) => ({
          ...farm,
          turbines: turbines.filter((t) => t.farmId === farm.id),
        })),
      });
    },
  );
}

// Never-reported ids on both sides of the others, so "last" can't come from the id order. R01 and
// R02 tie on time, and their power runs against the time order.
const STALE = [
  ['R03', 'No data in 15 min', 20],
  ['R04', 'No data in 30 min', 45],
  ['R05', 'No data in 60 min', 120],
] as const;
const MIXED_FLEET = [
  mockTurbine('A01', 'FARM01', null),
  mockTurbine('Z01', 'FARM01', null),
  mockTurbine('R02', 'FARM01', 5, 200),
  mockTurbine('R01', 'FARM01', 5, 100),
  mockTurbine('R06', 'FARM01', 1, 300),
  ...STALE.map(([id, , age], i) => mockTurbine(id, 'FARM01', age, 400 + i)),
];
const REPORTED_NEWEST_FIRST = ['R06', 'R01', 'R02', 'R03', 'R04', 'R05'];
const MIXED_COUNT = '6 of 8 turbines · 2 with no data hidden';
const AGE: Record<string, number> = { R06: 1, R01: 5, R02: 5, R03: 20, R04: 45, R05: 120 };
const oldestFirst = (a: string, b: string) => AGE[b] - AGE[a] || byId(a, b);

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.documentElement;
        return {
          viewport: window.innerWidth,
          overflow: Math.max(root.scrollWidth, document.body.scrollWidth) - root.clientWidth,
        };
      }),
    )
    .toEqual({ viewport: 360, overflow: 0 });
}

/** Inside the 360px viewport, so overflow hidden by the page's clipping fails too. */
async function expectWithinPhoneWidth(page: Page, element: Locator): Promise<void> {
  await expect(element).toBeVisible();
  const box = (await element.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(360);
}

test.describe('Turbines table', () => {
  test('lists turbines newest reading first with their columns and the match count', async ({
    page,
  }) => {
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
    await expect(count(page)).toHaveText(countText(turbines, turbines.length));
    await expect(page.getByTestId('sort-time')).toHaveAttribute('aria-sort', 'descending');
    await expect.poll(() => shownIds(page)).toEqual(byTime(turbines, 'desc').slice(0, 25));

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
    await expect(count(page)).toHaveText(countText(prairie, turbines.length));
    await expect(rows(page)).toHaveCount(Math.min(prairie.filter((t) => t.latest).length, 25));
    for (const farm of await rows(page).getByRole('cell').nth(1).allTextContents())
      expect(farm).toContain('Prairie Ridge');

    await search(page).fill('zzzz');
    await expect(page.getByTestId('no-matches')).toHaveText('No turbines match the filters.');
    await expect(count(page)).toHaveText(`0 of ${turbines.length} turbines`);

    await page.getByRole('button', { name: 'Clear search' }).click();
    await expect(search(page)).toHaveValue('');
    await expect(search(page)).toBeFocused();
    await expect(count(page)).toHaveText(countText(turbines, turbines.length));
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
    await expect(count(page)).toHaveText(countText(turbines, turbines.length));
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
      await expect(count(page)).toHaveText(countText(expected, turbines.length));
      const icons = await rows(page)
        .getByTestId('commissioned-icon')
        .evaluateAll((els) => els.map((e) => e.getAttribute('data-icon')));
      expect(new Set(icons)).toEqual(new Set(expected.some((t) => t.latest) ? [icon] : []));
    }

    await filter.selectOption({ label: 'Not commissioned' });
    await search(page).fill('TURB001');
    const both = turbines.filter((t) => !t.commissioned && t.id.toLowerCase().includes('turb001'));
    await expect(count(page)).toHaveText(countText(both, turbines.length));
    await filter.selectOption({ label: 'Any' });
    await expect(count(page)).toHaveText(
      countText(
        turbines.filter((t) => t.id.toLowerCase().includes('turb001')),
        turbines.length,
      ),
    );
  });

  test('a column header sorts ascending first; clicking again reverses', async ({ page }) => {
    const turbines = await openTurbines(page);
    const withReadings = turbines.filter((t) => t.latest);
    const ids = withReadings.map((t) => t.id).sort(byId);

    await page.getByTestId('sort-id').click();
    await expect(page.getByTestId('sort-id')).toHaveAttribute('aria-sort', 'ascending');
    await expect.poll(() => shownIds(page)).toEqual(ids.slice(0, 25));

    await page.getByTestId('sort-id').click();
    await expect(page.getByTestId('sort-id')).toHaveAttribute('aria-sort', 'descending');
    await expect.poll(() => shownIds(page)).toEqual(ids.reverse().slice(0, 25));

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

  test('the first click on Last reading, the default sort, gives oldest first', async ({ page }) => {
    const turbines = await openTurbines(page);
    const lastReading = page.getByTestId('sort-time');
    await expect(lastReading).toHaveAttribute('aria-sort', 'descending');

    await lastReading.click();
    await expect(lastReading).toHaveAttribute('aria-sort', 'ascending');
    await expect.poll(() => shownIds(page)).toEqual(byTime(turbines, 'asc').slice(0, 25));

    await lastReading.click();
    await expect(lastReading).toHaveAttribute('aria-sort', 'descending');
    await expect.poll(() => shownIds(page)).toEqual(byTime(turbines, 'desc').slice(0, 25));
  });

  test('ties on the last reading sort by id, in both directions', async ({ page }) => {
    await mockFleet(page, MIXED_FLEET);
    await openTurbines(page);
    await expect.poll(() => shownIds(page)).toEqual(REPORTED_NEWEST_FIRST);

    await page.getByTestId('sort-time').click();
    await expect
      .poll(() => shownIds(page))
      .toEqual(['R05', 'R04', 'R03', 'R01', 'R02', 'R06']);
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
    // A generated fleet: the fixture has 2 turbines (paging needs more than 25). One timestamp for
    // all, so the default sort falls back to the id order the assertions read.
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

test.describe('Commissioned cell by role', () => {
  // Reads only: the switch itself is in tests/data/commissioned.spec.ts.
  test('a viewer sees the icon and its words, and no switch', async ({ page }) => {
    await openTurbines(page);
    const row = page.locator('tr[data-turbine-id="TURB001"]');
    await expect(row.getByTestId('commissioned-icon')).toBeVisible();
    await expect(row.getByTestId('commissioned-cell')).toHaveText(/^\s*(Not commissioned|Commissioned)\s*$/);
    await expect(page.getByTestId('commissioned-toggle')).toHaveCount(0);
    await expect(page.getByRole('switch', { name: /^Mark .* as commissioned$/ })).toHaveCount(0);
  });

  for (const role of ['owner', 'admin'] as const) {
    test(`an ${role} gets a switch in the cell on /turbines and the farm page, not the icon or its words`, async ({
      page,
    }) => {
      await page.clock.setFixedTime(SEED_NOW);
      await page.route('**/api/events**', (route) => route.abort());
      await logIn(page, role);
      await mainNav(page).getByRole('link', { name: 'Turbines' }).click();
      const row = page.locator('tr[data-turbine-id="TURB001"]');
      await expect(row.getByRole('switch', { name: 'Mark TURB001 as commissioned' })).toBeVisible();
      await expect(row.getByTestId('commissioned-toggle')).toBeVisible();
      await expect(row.getByTestId('commissioned-icon')).toHaveCount(0);
      await expect(row.getByTestId('commissioned-cell')).not.toContainText('ommissioned');

      await row.getByRole('link', { name: 'Prairie Ridge' }).click();
      await expect(page).toHaveURL(/\/farms\/FARM01$/);
      await expect(page.getByRole('switch', { name: 'Mark TURB001 as commissioned' })).toBeVisible();
    });
  }
});

test.describe('Hide turbines with no data', () => {
  test('is on by default: never-reported turbines are hidden and the count says how many', async ({
    page,
  }) => {
    await mockFleet(page, MIXED_FLEET);
    await openTurbines(page);

    await expect(hideNoData(page)).toBeChecked();
    await expect(hideNoData(page)).toBeEnabled();
    await expect(page.getByTestId('hide-no-data')).toBeVisible();
    await expect(count(page)).toHaveText(MIXED_COUNT);
    await expect.poll(() => shownIds(page)).toEqual(REPORTED_NEWEST_FIRST);
  });

  test('turbines that have gone stale stay visible while it is on', async ({ page }) => {
    await mockFleet(page, MIXED_FLEET);
    await openTurbines(page);

    await expect(hideNoData(page)).toBeChecked();
    for (const [id, label] of STALE) {
      await expect(page.locator(`tr[data-turbine-id="${id}"]`).getByTestId('staleness')).toHaveText(
        label,
      );
    }
  });

  test('turned off, it lists them last whichever way the table is sorted', async ({ page }) => {
    await mockFleet(page, MIXED_FLEET);
    await openTurbines(page);
    const neverReported = ['A01', 'Z01'];

    await hideNoData(page).click();
    await expect(hideNoData(page)).not.toBeChecked();
    await expect(count(page)).toHaveText('8 of 8 turbines');
    await expect(page.getByTestId('sort-time')).toHaveAttribute('aria-sort', 'descending');
    await expect.poll(() => shownIds(page)).toEqual([...REPORTED_NEWEST_FIRST, ...neverReported]);
    await expect(page.locator('tr[data-turbine-id="A01"]').getByTestId('staleness')).toHaveText(
      'No readings yet',
    );

    await page.getByTestId('sort-time').click();
    await expect(page.getByTestId('sort-time')).toHaveAttribute('aria-sort', 'ascending');
    await expect
      .poll(() => shownIds(page))
      .toEqual([...[...REPORTED_NEWEST_FIRST].sort(oldestFirst), ...neverReported]);

    await page.getByTestId('sort-power').click();
    await expect(page.getByTestId('sort-power')).toHaveAttribute('aria-sort', 'ascending');
    const byPower = ['R01', 'R02', 'R06', 'R03', 'R04', 'R05'];
    await expect.poll(() => shownIds(page)).toEqual([...byPower, ...neverReported]);

    await page.getByTestId('sort-power').click();
    await expect(page.getByTestId('sort-power')).toHaveAttribute('aria-sort', 'descending');
    await expect.poll(() => shownIds(page)).toEqual([...byPower.reverse(), ...neverReported]);

    await hideNoData(page).click();
    await expect(hideNoData(page)).toBeChecked();
    await expect(count(page)).toHaveText(MIXED_COUNT);
    await expect(rows(page)).toHaveCount(6);
  });

  test('is not saved: a reload turns it back on', async ({ page }) => {
    await mockFleet(page, MIXED_FLEET);
    await openTurbines(page);
    await hideNoData(page).click();
    await expect(hideNoData(page)).not.toBeChecked();

    await page.reload();
    await expect(hideNoData(page)).toBeChecked();
    await expect(count(page)).toHaveText(MIXED_COUNT);
  });

  test('status "No readings yet" shows them with the switch off and disabled; another status restores it', async ({
    page,
  }) => {
    await mockFleet(page, MIXED_FLEET);
    await openTurbines(page);
    const statusFilter = page.getByTestId('status-filter');

    await statusFilter.selectOption({ label: 'No readings yet' });
    await expect(hideNoData(page)).not.toBeChecked();
    await expect(hideNoData(page)).toBeDisabled();
    await expect(count(page)).toHaveText('2 of 8 turbines');
    await expect.poll(() => shownIds(page)).toEqual(['A01', 'Z01']);

    await statusFilter.selectOption({ label: 'All statuses' });
    await expect(hideNoData(page)).toBeChecked();
    await expect(hideNoData(page)).toBeEnabled();
    await expect(count(page)).toHaveText(MIXED_COUNT);
    await expect(rows(page)).toHaveCount(6);

    // The user's own setting comes back too, not just the default.
    await hideNoData(page).click();
    await statusFilter.selectOption({ label: 'No readings yet' });
    await expect(hideNoData(page)).toBeDisabled();
    await statusFilter.selectOption({ label: 'Reporting' });
    await expect(hideNoData(page)).not.toBeChecked();
    await expect(hideNoData(page)).toBeEnabled();
    await expect.poll(() => shownIds(page)).toEqual(['R06', 'R01', 'R02']);
  });

  test('the message says when only the switch hides the one match, and not otherwise', async ({
    page,
  }) => {
    await mockFleet(page, MIXED_FLEET);
    await openTurbines(page);

    await search(page).fill('Z01');
    await expect(page.getByTestId('no-matches')).toHaveText(
      '1 turbine with no readings yet is hidden. Turn off “Hide turbines with no data” to show it.',
    );
    await expect(count(page)).toHaveText('0 of 8 turbines · 1 with no data hidden');

    await search(page).fill('zzzz');
    await expect(page.getByTestId('no-matches')).toHaveText('No turbines match the filters.');
    await expect(count(page)).toHaveText('0 of 8 turbines');
  });

  test('a farm where no turbine has reported explains the empty table, and the switch reveals them', async ({
    page,
  }) => {
    await mockFleet(page, [
      mockTurbine('N01', 'FARM02', null),
      mockTurbine('N02', 'FARM02', null),
      mockTurbine('R01', 'FARM01', 5),
    ]);
    await page.clock.setFixedTime(SEED_NOW);
    await page.route('**/api/events**', (route) => route.abort());
    await logIn(page, 'viewer');
    await page.goto('/farms/FARM02');

    const noMatches = page.getByTestId('no-matches');
    await expect(noMatches).toHaveText(
      '2 turbines with no readings yet are hidden. Turn off “Hide turbines with no data” to show them.',
    );
    await expect(count(page)).toHaveText('0 of 2 turbines · 2 with no data hidden');
    await expect(rows(page)).toHaveCount(0);

    await hideNoData(page).click();
    await expect(noMatches).toHaveCount(0);
    await expect(count(page)).toHaveText('2 of 2 turbines');
    await expect.poll(() => shownIds(page)).toEqual(['N01', 'N02']);
  });

  test('a hidden turbine appears on its first live reading, without a reload', async ({ page }) => {
    await mockFleet(page, MIXED_FLEET);
    // A fulfilled stream ends, so the browser reconnects by itself and picks up the new body.
    let stream = ': no events yet\n\n';
    await openTurbines(page, (route) =>
      route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: stream,
      }),
    );
    const a01 = page.locator('tr[data-turbine-id="A01"]');
    await expect(count(page)).toHaveText(MIXED_COUNT);
    await expect(a01).toHaveCount(0);

    const reading = mockReading('A01', 'FARM01', 0, 1234);
    stream = `event: telemetry.received\nid: 1-0\ndata: ${JSON.stringify(reading)}\n\n`;

    await expect(rows(page).first()).toHaveAttribute('data-turbine-id', 'A01', { timeout: 15_000 });
    await expect(a01.getByTestId('staleness')).toHaveText('Reporting');
    await expect(count(page)).toHaveText('7 of 8 turbines · 1 with no data hidden');
  });

  test('at 360px the filter row stays on screen and the page does not scroll sideways', async ({
    page,
  }) => {
    await mockFleet(page, MIXED_FLEET);
    await openTurbines(page);
    await page.setViewportSize({ width: 360, height: 740 });

    // The longest count line, then the longest message, which both have to wrap.
    await expect(count(page)).toHaveText(MIXED_COUNT);
    const onScreen = [
      search(page),
      page.getByTestId('status-filter'),
      page.getByTestId('commissioned-filter'),
      hideNoData(page),
      count(page),
    ];
    for (const element of onScreen) await expectWithinPhoneWidth(page, element);
    await expectNoSidewaysScroll(page);

    await search(page).fill('A01');
    const message = page.getByTestId('no-matches').locator('div');
    await expect(message).toContainText('1 turbine with no readings yet is hidden.');
    await expectWithinPhoneWidth(page, message);
    await expectNoSidewaysScroll(page);
  });
});
