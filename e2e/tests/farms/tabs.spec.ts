import { expect, test, type Locator, type Page } from '@playwright/test';
import { signIn } from '../support/session.js';

// Plan 15.5 (read-only): the routed section tabs (shared PageTabs, Material tab nav bar) in a real
// browser. jsdom has neither focus movement by real key events nor layout, so the unit specs can't
// check either: the keyboard pattern (roving tabindex, arrows wrap, Home/End, Enter/Space follow the
// link, focus alone doesn't navigate) and the 320 px layout (one row, no page overflow, Material's
// pagination arrows only when the tabs don't fit).

const FARM_URL = '/farms/FARM01';

const tablist = (page: Page, name = 'Farm') => page.getByRole('tablist', { name });
const tab = (page: Page, name: string) => tablist(page).getByRole('tab', { name, exact: true });
const focusedTab = (page: Page) => page.locator('[role="tab"]:focus');

/**
 * Material's pagination arrows: mouse-only <div>s with no role, name or test hook (keyboard users
 * scroll by moving focus), so the documented Material class inside our test-id'd tab bar is the
 * only handle on them.
 */
const arrow = (bar: Locator, side: 'before' | 'after') =>
  bar.locator(`.mat-mdc-tab-header-pagination-${side}`);

const box = async (locator: Locator) => {
  const b = await locator.boundingBox();
  if (!b) throw new Error('not rendered');
  return b;
};

/** A viewer at SEED_NOW, no live stream (the tabs don't depend on it). */
async function open(page: Page, url = FARM_URL, section = 'Farm'): Promise<void> {
  await page.route('**/api/events**', (route) => route.abort());
  await signIn(page, 'viewer');
  await page.goto(url);
  await expect(tablist(page, section)).toBeVisible();
}

test.describe('Farm tabs: keyboard', () => {
  test('the active tab is the only tab stop', async ({ page }) => {
    await open(page);

    await expect(tab(page, 'Overview')).toHaveAttribute('tabindex', '0');
    await expect(tab(page, 'History')).toHaveAttribute('tabindex', '-1');
    await expect(tab(page, 'Weather history')).toHaveAttribute('tabindex', '-1');
    await expect(tab(page, 'Overview')).toHaveAttribute(
      'aria-controls',
      (await page.getByTestId('farm-tab-panel').getAttribute('id'))!,
    );
    await expect(page.getByRole('tabpanel')).toBeVisible();
  });

  test('arrow keys move focus between the tabs and wrap, without navigating', async ({ page }) => {
    await open(page);
    await tab(page, 'Overview').focus();

    await page.keyboard.press('ArrowRight');
    await expect(tab(page, 'History')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(tab(page, 'Weather history')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(tab(page, 'Overview')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(tab(page, 'Weather history')).toBeFocused();

    // Focus alone doesn't follow the link.
    await expect(page).toHaveURL(new RegExp(`${FARM_URL}$`));
    await expect(tab(page, 'Overview')).toHaveAttribute('aria-selected', 'true');
  });

  test('Home and End jump to the first and last tab', async ({ page }) => {
    await open(page);
    await tab(page, 'Overview').focus();

    await page.keyboard.press('End');
    await expect(tab(page, 'Weather history')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(tab(page, 'Overview')).toBeFocused();
    await expect(page).toHaveURL(new RegExp(`${FARM_URL}$`));
  });

  test('Enter opens the focused tab, and Space does too', async ({ page }) => {
    await open(page);
    await tab(page, 'Overview').focus();

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`${FARM_URL}/history$`));
    await expect(tab(page, 'History')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, 'History')).toHaveAttribute('tabindex', '0');
    await expect(tab(page, 'Overview')).toHaveAttribute('aria-selected', 'false');

    await tab(page, 'Weather history').focus();
    await page.keyboard.press(' ');
    await expect(page).toHaveURL(new RegExp(`${FARM_URL}/weather$`));
    await expect(tab(page, 'Weather history')).toHaveAttribute('aria-selected', 'true');
  });

  // BUG (angular-engineer): every tab route renders its own PageTabs (farm-page, farm-history-page,
  // farm-weather-history-page each wrap their body in <app-farm-tabs>/<app-farm-header>), so
  // following a tab destroys the tab bar and focus falls back to <body>. A keyboard user has to tab
  // through the side nav again to reach the tabs. Same for the Alerting and Unallocated tabs.
  // Remove test.fail once focus lands on the newly selected tab (or the bar survives navigation).
  test.fail('keeps focus on the tab it opened', async ({ page }) => {
    await open(page);
    await tab(page, 'Overview').focus();

    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(new RegExp(`${FARM_URL}/history$`));

    await expect(tab(page, 'History')).toBeFocused({ timeout: 2_000 });
  });
});

test.describe('Section tabs at 320 px', () => {
  test.use({ viewport: { width: 320, height: 720 }, reducedMotion: 'reduce' });

  test('the farm tabs stay on one row, scroll inside the bar and show the pagination arrows', async ({
    page,
  }) => {
    await open(page);
    const bar = tablist(page);

    // No horizontal page overflow; the bar fits the viewport.
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
    const barBox = await box(bar);
    expect(barBox.x).toBeGreaterThanOrEqual(0);
    expect(barBox.x + barBox.width).toBeLessThanOrEqual(320);

    // One row: every tab sits at the same height.
    const ys = await bar.getByRole('tab').evaluateAll((tabs) =>
      tabs.map((t) => Math.round(t.getBoundingClientRect().y)),
    );
    expect(new Set(ys).size).toBe(1);

    // The tabs don't fit, so Material shows its arrows, and the last tab starts out clipped.
    await expect(arrow(bar, 'before')).toBeVisible();
    await expect(arrow(bar, 'after')).toBeVisible();
    const afterLeft = (await box(arrow(bar, 'after'))).x;
    const weather = tab(page, 'Weather history');
    expect((await box(weather)).x + (await box(weather)).width).toBeGreaterThan(afterLeft);

    // Each click on the arrow scrolls the bar by a step (Material: a third of its width) until the
    // last tab is fully in view; the page itself never scrolls sideways. Reduced motion (above)
    // turns off Material's 500 ms slide, so each step lands at once.
    const right = async () => {
      const b = await box(weather);
      return b.x + b.width;
    };
    let clicks = 0;
    for (let r = await right(); r > afterLeft + 1; clicks++) {
      expect(clicks, 'arrow clicks to reveal the last tab').toBeLessThan(5);
      await arrow(bar, 'after').click();
      await expect.poll(right).toBeLessThan(r);
      r = await right();
    }
    expect(clicks).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  });

  test('a deep link to the last farm tab scrolls it into view', async ({ page }) => {
    await open(page, `${FARM_URL}/weather`);
    const bar = tablist(page);
    const weather = tab(page, 'Weather history');
    await expect(weather).toHaveAttribute('aria-selected', 'true');

    const afterLeft = (await box(arrow(bar, 'after'))).x;
    const beforeRight = await box(arrow(bar, 'before')).then((b) => b.x + b.width);
    await expect
      .poll(async () => {
        const b = await box(weather);
        return b.x >= beforeRight - 1 && b.x + b.width <= afterLeft + 1;
      })
      .toBe(true);
  });

  test('moving keyboard focus to a clipped tab scrolls it into view', async ({ page }) => {
    await open(page);
    const bar = tablist(page);
    await tab(page, 'Overview').focus();

    await page.keyboard.press('End');
    await expect(focusedTab(page)).toHaveText('Weather history');
    const afterLeft = (await box(arrow(bar, 'after'))).x;
    await expect
      .poll(async () => {
        const b = await box(tab(page, 'Weather history'));
        return b.x + b.width <= afterLeft + 1;
      })
      .toBe(true);
  });

  test('the Alerting tabs fit at 320 px, so no arrows are shown', async ({ page }) => {
    await open(page, '/alerting/history', 'Alerting');
    const bar = tablist(page, 'Alerting');

    await expect(bar.getByRole('tab')).toHaveText(['History', 'Rules']);
    await expect(arrow(bar, 'before')).toBeHidden();
    await expect(arrow(bar, 'after')).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  });
});
