import { expect, test, type Page } from '@playwright/test';
import { findRule, removeRules, updateRule, type RuleInput } from '../support/rules.js';
import { apiToken, signIn } from '../support/session.js';

/**
 * [DATA] Alert rule CRUD through the Rules page (plan 7.2, 7.4, 7.5, 7.8, 9.5): an owner adds,
 * edits and deletes a rule in the dialogs; a duplicate is refused with the 409 message; a
 * viewer's open Rules page follows the change live (`alert-config.changed` over SSE) and offers no
 * Edit/Delete. Serial: the tests share one rule.
 *
 * Re-runnable: the rule ("Wind speed above … m/s", Info then Warning) is one no seed has, it never
 * triggers (no reading has 45 m/s of wind and it lives for seconds), and beforeAll/afterAll delete
 * any rule with these keys, so nothing is left behind.
 */

const INFO: RuleInput = {
  measurementMetric: 'windSpeedMs',
  comparison: 'above',
  valueMetric: 45,
  alertLevel: 'info',
};
const WARN: RuleInput = { ...INFO, alertLevel: 'warn' };

const ruleRow = (page: Page, id: string) =>
  page.locator(`[data-testid="rule"][data-rule-id="${id}"]`);
const heading = (page: Page) => page.getByRole('heading', { level: 2, name: /^\d+ rules?$/ });
/** The listed rule count ("4 rules"), 0 for the empty state. */
async function ruleCount(page: Page): Promise<number> {
  await expect(heading(page).or(page.getByTestId('no-rules'))).toBeVisible();
  if (await page.getByTestId('no-rules').count()) return 0;
  return Number(/(\d+)/.exec((await heading(page).textContent()) ?? '')![1]);
}
const rulesText = (n: number) => `${n} ${n === 1 ? 'rule' : 'rules'}`;

async function openRules(page: Page, role: 'owner' | 'viewer' = 'owner'): Promise<void> {
  await signIn(page, role);
  await page.goto('/alerting/rules');
  await expect(page.getByTestId('live-status')).toHaveText('Live');
  await expect(page.getByTestId('rules-loading')).toHaveCount(0);
}

test.describe('[DATA] Alert rules', () => {
  test.describe.configure({ mode: 'serial' });

  test.beforeAll(async ({ request }) => {
    const token = await apiToken(request, 'owner');
    await removeRules(request, token, INFO);
    await removeRules(request, token, WARN);
  });

  test.afterAll(async ({ request }) => {
    const token = await apiToken(request, 'owner');
    await removeRules(request, token, INFO);
    await removeRules(request, token, WARN);
    expect(await findRule(request, token, INFO)).toBeUndefined();
    expect(await findRule(request, token, WARN)).toBeUndefined();
  });

  test('[DATA] an owner adds a rule in the dialog and it is listed', async ({ page, request }) => {
    await openRules(page);
    const before = await ruleCount(page);

    await page.getByRole('button', { name: 'Add rule' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add alert rule' });
    await dialog.getByLabel('Metric').selectOption({ label: 'Wind speed (m/s)' });
    await dialog.getByLabel('Condition').selectOption({ label: 'above' });
    await dialog.getByLabel('Threshold').fill('45');
    await dialog.getByLabel('Level').selectOption({ label: 'Info' });
    await dialog.getByRole('button', { name: 'Add rule' }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('rules-notice')).toHaveText(
      'Rule added: Wind speed above 45 m/s.',
    );
    await expect(heading(page)).toHaveText(rulesText(before + 1));
    const rule = await findRule(request, await apiToken(request, 'owner'), INFO);
    expect(rule).toMatchObject({ ...INFO, enabled: true });
    await expect(ruleRow(page, rule!.id).getByRole('cell')).toHaveText([
      'Wind speed (m/s)',
      'above',
      '45 m/s',
      'Info',
      /Edit.*Delete/,
    ]);
  });

  test('[DATA] adding the same rule again is refused with the duplicate message', async ({
    page,
    request,
  }) => {
    await openRules(page);
    const count = await ruleCount(page);
    await page.getByRole('button', { name: 'Add rule' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add alert rule' });
    await dialog.getByLabel('Metric').selectOption({ label: 'Wind speed (m/s)' });
    await dialog.getByLabel('Threshold').fill('50');
    await dialog.getByLabel('Level').selectOption({ label: 'Info' });
    await dialog.getByRole('button', { name: 'Add rule' }).click();

    await expect(dialog.getByTestId('rule-error')).toHaveText(
      'An Info rule for “Wind speed above” already exists. Edit that rule, or choose another condition or level.',
    );
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(heading(page)).toHaveText(rulesText(count));
    expect(await findRule(request, await apiToken(request, 'owner'), INFO)).toMatchObject({
      valueMetric: 45,
    });
  });

  test('[DATA] Edit opens the rule prefilled and saves the new threshold and level', async ({
    page,
    request,
  }) => {
    const token = await apiToken(request, 'owner');
    const rule = (await findRule(request, token, INFO))!;
    await openRules(page);
    await ruleRow(page, rule.id)
      .getByRole('button', { name: 'Edit rule: Wind speed above 45 m/s' })
      .click();

    const dialog = page.getByRole('dialog', { name: 'Edit alert rule' });
    await expect(dialog.getByLabel('Metric')).toHaveValue('windSpeedMs');
    await expect(dialog.getByLabel('Condition')).toHaveValue('above');
    await expect(dialog.getByLabel('Threshold')).toHaveValue('45');
    await expect(dialog.getByLabel('Level')).toHaveValue('info');
    await dialog.getByLabel('Threshold').fill('46');
    await dialog.getByLabel('Level').selectOption({ label: 'Warning' });
    await dialog.getByRole('button', { name: 'Save changes' }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('rules-notice')).toHaveText(
      'Rule updated: Wind speed above 46 m/s.',
    );
    await expect(ruleRow(page, rule.id).getByRole('cell').nth(2)).toHaveText('46 m/s');
    await expect(ruleRow(page, rule.id).getByTestId('rule-level')).toHaveText('Warning');
    expect(await findRule(request, token, WARN)).toMatchObject({ id: rule.id, valueMetric: 46 });
  });

  test("[DATA] a viewer's open Rules page follows another user's change live, read-only", async ({
    page,
    request,
  }) => {
    const token = await apiToken(request, 'owner');
    const rule = (await findRule(request, token, WARN))!;
    await openRules(page, 'viewer');
    const row = ruleRow(page, rule.id);
    await expect(row.getByRole('cell').nth(2)).toHaveText('46 m/s');
    await expect(row.getByRole('button')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add rule' })).toHaveCount(0);
    await page.evaluate(() => ((window as { e2eNoReload?: boolean }).e2eNoReload = true));

    // Another user changes it (through the API): alert-config.changed → the list reloads.
    await updateRule(request, token, rule.id, { valueMetric: 47 });
    await expect(row.getByRole('cell').nth(2)).toHaveText('47 m/s');
    expect(await page.evaluate(() => (window as { e2eNoReload?: boolean }).e2eNoReload)).toBe(true);
  });

  test('[DATA] Delete asks first: Cancel keeps the rule, Delete removes it', async ({
    page,
    request,
  }) => {
    const token = await apiToken(request, 'owner');
    const rule = (await findRule(request, token, WARN))!;
    await openRules(page);
    const count = await ruleCount(page);
    const row = ruleRow(page, rule.id);
    const deleteButton = row.getByRole('button', { name: 'Delete rule: Wind speed above 47 m/s' });

    await deleteButton.click();
    const dialog = page.getByTestId('delete-dialog');
    await expect(dialog.getByRole('heading')).toHaveText('Delete alert rule?');
    await expect(dialog).toContainText('Wind speed above 47 m/s (Warning) will be removed.');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();
    await expect(row).toBeVisible();

    await deleteButton.click();
    await dialog.getByTestId('confirm-delete').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('rules-notice')).toHaveText(
      'Rule deleted: Wind speed above 47 m/s.',
    );
    await expect(row).toHaveCount(0);
    if (count > 1) await expect(heading(page)).toHaveText(rulesText(count - 1));
    else await expect(page.getByTestId('no-rules')).toBeVisible();
    expect(await findRule(request, token, WARN)).toBeUndefined();
  });
});
