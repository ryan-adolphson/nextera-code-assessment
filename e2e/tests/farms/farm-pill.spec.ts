import { expect, test, type Locator, type Page } from '@playwright/test';
import { farmsFrom, farmsResponse, mainNav, type FleetFarm } from '../support/fleet.js';
import { logIn, SEED_NOW, signIn } from '../support/session.js';

// Plan 3.13–3.16: the farm id pill (ui/farm-pill.ts) in a real browser, on the real API: where it
// shows, that it stays read-only, what it does to row heights, and how it wraps on a phone. The
// Unallocated tables' pills are in tests/data/unallocated.spec.ts (they need held readings).
// Read-only; live stream aborted, so nothing changes mid-test.

async function open(page: Page): Promise<FleetFarm[]> {
  await page.clock.setFixedTime(SEED_NOW);
  await page.route('**/api/events**', (route) => route.abort());
  const farms = farmsResponse(page);
  await logIn(page, 'viewer');
  return farmsFrom(farms);
}

/** The table's data rows' heights, px. */
const rowHeights = (rows: Locator) =>
  rows.evaluateAll((trs) => trs.map((tr) => tr.getBoundingClientRect().height));

async function expectNoSidewaysScroll(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const root = document.documentElement;
        return Math.max(root.scrollWidth, document.body.scrollWidth) - root.clientWidth;
      }),
    )
    .toBe(0);
}

const FARM_TABS = [
  ['Overview', '/farms/FARM01'],
  ['History', '/farms/FARM01/history'],
  ['Weather history', '/farms/FARM01/weather'],
] as const;

test.describe('Farm pill', () => {
  test('the Farms table shows every farm’s id in a pill beside its name', async ({ page }) => {
    const farms = await open(page);
    const rows = page.getByTestId('farms').locator('tbody tr');
    await expect(rows).toHaveCount(farms.length);
    await expect(rows.getByTestId('farm-pill')).toHaveText(farms.map((f) => f.id));
    await expect(rows.nth(0).getByRole('cell').first()).toHaveText(
      `${farms[0].name} ${farms[0].id}`,
    );
  });

  test('clicking a pill on /farms opens the farm', async ({ page }) => {
    const farms = await open(page);
    const farm = farms.find((f) => f.id === 'FARM02')!;
    await page
      .getByTestId('farms')
      .locator('tbody tr')
      .filter({ hasText: 'FARM02' })
      .getByTestId('farm-pill')
      .click();
    await expect(page).toHaveURL(/\/farms\/FARM02$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(`${farm.name} FARM02`);
  });

  test('a pill is plain text: no link, no button, no tab stop', async ({ page }) => {
    await open(page);
    const pill = page.getByTestId('farms').getByTestId('farm-pill').first();
    await expect(pill).toBeVisible();
    // Neither the pill nor anything in it is reachable from the keyboard.
    const interactive = await pill.evaluate((chip) =>
      [chip, ...chip.querySelectorAll('*')].filter(
        (el) => (el as HTMLElement).tabIndex >= 0 || el.matches('a, button, [role=button], [role=link]'),
      ).length,
    );
    expect(interactive).toBe(0);
  });

  test('the id in the farm header’s pill can be selected and copied', async ({ page }) => {
    await open(page);
    await page.goto('/farms/FARM01');
    const pill = page.getByRole('heading', { level: 1 }).getByTestId('farm-pill');
    await pill.dblclick();
    expect(await page.evaluate(() => getSelection()!.toString().trim())).toBe('FARM01');
  });

  test('the Turbines table links the name and shows the id in a pill outside the link', async ({
    page,
  }) => {
    await open(page);
    await mainNav(page).getByRole('link', { name: 'Turbines' }).click();
    const row = page.locator('tr[data-turbine-id="TURB002"]');
    const cell = row.getByRole('cell').nth(1);
    await expect(cell).toHaveText('High Plains FARM02');
    await expect(cell.getByTestId('farm-pill')).toHaveText('FARM02');
    await expect(cell.getByRole('link')).toHaveText('High Plains');
    await cell.getByRole('link').click();
    await expect(page).toHaveURL(/\/farms\/FARM02$/);
  });

  for (const [tab, path] of FARM_TABS) {
    test(`the farm header shows the id in a pill on the ${tab} tab`, async ({ page }) => {
      await open(page);
      await page.goto('/farms/FARM01');
      await page.getByRole('tab', { name: tab, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      const heading = page.getByRole('heading', { level: 1 });
      await expect(heading).toHaveText('Prairie Ridge FARM01');
      await expect(heading.getByTestId('farm-pill')).toHaveText('FARM01');
      await expect(page.getByRole('tab', { name: tab, exact: true })).toHaveAttribute(
        'aria-selected',
        'true',
      );
    });
  }

  test('pills fit the tables’ one-line rows: 22 px tall in 40 px rows', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await open(page);
    const farmRows = page.getByTestId('farms').locator('tbody tr');
    await expect(farmRows.first()).toBeVisible();
    const pill = farmRows.first().getByTestId('farm-pill');
    expect((await pill.boundingBox())!.height).toBe(22);
    expect(new Set(await rowHeights(farmRows))).toEqual(new Set([40]));

    await mainNav(page).getByRole('link', { name: 'Turbines' }).click();
    const turbineRows = page.getByTestId('turbines').locator('tr[data-turbine-id]');
    await expect(turbineRows.first()).toBeVisible();
    expect(new Set(await rowHeights(turbineRows))).toEqual(new Set([40]));
  });

  test.describe('on a 360 px phone', () => {
    test.use({ viewport: { width: 360, height: 740 } });

    for (const [tab, path] of FARM_TABS) {
      test(`the ${tab} tab doesn’t scroll sideways and the pill sits beside the name`, async ({
        page,
      }) => {
        await signIn(page, 'viewer');
        await page.goto(path);
        const heading = page.getByRole('heading', { level: 1 });
        await expect(heading).toHaveText('Prairie Ridge FARM01');
        await expectNoSidewaysScroll(page);

        const pill = (await heading.getByTestId('farm-pill').boundingBox())!;
        expect(pill.x + pill.width).toBeLessThanOrEqual(360);
        // One line: the heading is one line of text high, with the pill in it.
        const box = (await heading.boundingBox())!;
        expect(box.height).toBeLessThanOrEqual(40);
        expect(pill.y).toBeGreaterThanOrEqual(box.y);
        expect(pill.y + pill.height).toBeLessThanOrEqual(box.y + box.height);
      });
    }

    test('a long farm name wraps and the pill goes to its own line, inside the window', async ({
      page,
    }) => {
      const long = 'Prairie Ridge Northern Extension Wind Project';
      await page.route(
        (url) => url.pathname.endsWith('/api/farms'),
        async (route) => {
          const real = (await (await route.fetch()).json()) as FleetFarm[];
          await route.fulfill({
            json: real.map((f) => (f.id === 'FARM01' ? { ...f, name: long } : f)),
          });
        },
      );
      await signIn(page, 'viewer');
      await page.goto('/farms/FARM01');
      const heading = page.getByRole('heading', { level: 1 });
      await expect(heading).toHaveText(`${long} FARM01`);
      await expectNoSidewaysScroll(page);

      const layout = await heading.evaluate((h1) => {
        const range = document.createRange();
        range.selectNodeContents([...h1.childNodes].find((n) => n.textContent?.trim())!);
        const lines = [...range.getClientRects()];
        const pill = h1.querySelector('[data-testid="farm-pill"]')!.getBoundingClientRect();
        return {
          nameBottom: lines.at(-1)!.bottom,
          nameRight: Math.max(...lines.map((r) => r.right)),
          pillTop: pill.top,
          pillLeft: pill.left,
          pillRight: pill.right,
        };
      });
      test.info().annotations.push({ type: 'long-name-360', description: JSON.stringify(layout) });
      expect(layout.nameRight).toBeLessThanOrEqual(360);
      expect(layout.pillTop).toBeGreaterThanOrEqual(layout.nameBottom);
      expect(layout.pillLeft).toBeGreaterThanOrEqual(0);
      expect(layout.pillRight).toBeLessThanOrEqual(360);
    });

    test('the Farms and Turbines pages don’t scroll sideways with pills in their tables', async ({
      page,
    }) => {
      await signIn(page, 'viewer');
      await expect(page.getByTestId('farms').getByTestId('farm-pill').first()).toBeAttached();
      await expectNoSidewaysScroll(page);
      await page.goto('/turbines');
      await expect(page.getByTestId('turbines').getByTestId('farm-pill').first()).toBeAttached();
      await expectNoSidewaysScroll(page);
    });
  });
});
