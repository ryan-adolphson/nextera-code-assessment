import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { createTurbine } from '../support/fleet.js';
import {
  ensureRule,
  expectRuleState,
  findRule,
  removeRules,
  ruleRow,
  ruleSwitch,
  updateRule,
  type RuleInput,
} from '../support/rules.js';
import { apiToken, signIn } from '../support/session.js';
import { uploadTelemetry } from '../support/telemetry.js';
import { removeUnallocated } from '../support/unallocated.js';

/**
 * [DATA] Alert rule CRUD and enable/disable through the Rules page (plan 7.2, 7.4, 7.5, 7.7, 7.8,
 * 9.5): an owner adds, edits, switches off and on, and deletes a rule; a duplicate is refused with
 * the 409 message; a failed switch rolls back; a viewer's open Rules page follows changes live
 * (`alert-config.changed` over SSE) and offers no Edit/Delete or switch. Serial: the tests share
 * one rule.
 *
 * Re-runnable: the rules ("Wind speed above … m/s", Info then Warning, and an Error one created
 * disabled) are ones no seed has, they never trigger (no reading has 44+ m/s of wind and they
 * live for seconds), and beforeAll/afterAll delete any rule with these keys, so nothing is left
 * behind.
 */

const INFO: RuleInput = {
  measurementMetric: 'windSpeedMs',
  comparison: 'above',
  valueMetric: 45,
  alertLevel: 'info',
};
const WARN: RuleInput = { ...INFO, alertLevel: 'warn' };
/** Created disabled in the editor, deleted right after. */
const ERROR: RuleInput = { ...INFO, valueMetric: 44, alertLevel: 'error' };

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

const markDocument = (page: Page) =>
  page.evaluate(() => ((window as { e2eNoReload?: boolean }).e2eNoReload = true));
const sameDocument = (page: Page) =>
  page.evaluate(() => (window as { e2eNoReload?: boolean }).e2eNoReload);

const isRulePatch = (url: URL) => /\/api\/alert-configs\/[^/]+$/.test(url.pathname);

test.describe('[DATA] Alert rules', () => {
  test.describe.configure({ mode: 'serial' });

  const removeAll = async (request: APIRequestContext) => {
    const token = await apiToken(request, 'owner');
    for (const key of [INFO, WARN, ERROR]) await removeRules(request, token, key);
    return token;
  };

  test.beforeAll(async ({ request }) => {
    await removeAll(request);
  });

  test.afterAll(async ({ request }) => {
    const token = await removeAll(request);
    for (const key of [INFO, WARN, ERROR]) expect(await findRule(request, token, key)).toBeUndefined();
  });

  test('[DATA] an owner adds a rule in the dialog, enabled by default, and it is listed', async ({
    page,
    request,
  }) => {
    await openRules(page);
    const before = await ruleCount(page);

    await page.getByRole('button', { name: 'Add rule' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add alert rule' });
    await expect(dialog.getByRole('switch', { name: 'Enabled' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
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
    const row = ruleRow(page, rule!.id);
    await expect(row.getByRole('cell')).toHaveText([
      'Wind speed (m/s)',
      'above',
      '45 m/s',
      'Info',
      '',
      /Edit.*Delete/,
    ]);
    await expectRuleState(row, 'Wind speed above 45 m/s', true);
  });

  test('[DATA] a rule added with Enabled switched off is created disabled', async ({
    page,
    request,
  }) => {
    await openRules(page);
    await page.getByRole('button', { name: 'Add rule' }).click();
    const dialog = page.getByRole('dialog', { name: 'Add alert rule' });
    await dialog.getByLabel('Metric').selectOption({ label: 'Wind speed (m/s)' });
    await dialog.getByLabel('Threshold').fill('44');
    await dialog.getByLabel('Level').selectOption({ label: 'Error' });
    const enabled = dialog.getByRole('switch', { name: 'Enabled' });
    await enabled.click();
    await expect(enabled).toHaveAttribute('aria-checked', 'false');
    await dialog.getByRole('button', { name: 'Add rule' }).click();

    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('rules-notice')).toHaveText(
      'Rule added: Wind speed above 44 m/s.',
    );
    const token = await apiToken(request, 'owner');
    const rule = await findRule(request, token, ERROR);
    expect(rule).toMatchObject({ ...ERROR, enabled: false });
    await expectRuleState(ruleRow(page, rule!.id), 'Wind speed above 44 m/s', false);
    await removeRules(request, token, ERROR);
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

  test("[DATA] the editor's Enabled switch shows the rule's state and saves a change", async ({
    page,
    request,
  }) => {
    const token = await apiToken(request, 'owner');
    const rule = (await findRule(request, token, WARN))!;
    await openRules(page);
    const row = ruleRow(page, rule.id);
    const edit = row.getByRole('button', { name: 'Edit rule: Wind speed above 46 m/s' });
    const dialog = page.getByRole('dialog', { name: 'Edit alert rule' });
    const enabled = dialog.getByRole('switch', { name: 'Enabled' });

    await edit.click();
    await expect(enabled).toHaveAttribute('aria-checked', 'true');
    await expect(enabled).toHaveAccessibleDescription(
      'Disabled rules are kept, but new readings aren’t checked against them.',
    );
    await enabled.click();
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('rules-notice')).toHaveText(
      'Rule updated: Wind speed above 46 m/s.',
    );
    await expectRuleState(row, 'Wind speed above 46 m/s', false);
    expect(await findRule(request, token, WARN)).toMatchObject({ id: rule.id, enabled: false });

    await edit.click();
    await expect(enabled).toHaveAttribute('aria-checked', 'false');
    await enabled.click();
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toBeHidden();
    await expectRuleState(row, 'Wind speed above 46 m/s', true);
    expect(await findRule(request, token, WARN)).toMatchObject({ id: rule.id, enabled: true });
  });

  test('[DATA] switching a rule off and on in its row is saved and survives a reload', async ({
    page,
    request,
  }) => {
    const token = await apiToken(request, 'owner');
    const rule = (await findRule(request, token, WARN))!;
    await openRules(page);
    const row = ruleRow(page, rule.id);
    await expectRuleState(row, 'Wind speed above 46 m/s', true);

    await ruleSwitch(row).click();
    await expect(page.getByTestId('rules-notice')).toHaveText(
      'Rule disabled: Wind speed above 46 m/s.',
    );
    await expectRuleState(row, 'Wind speed above 46 m/s', false);
    await expect(row.getByTestId('rule-enabled-toggle')).not.toHaveAttribute('data-pending');
    expect(await findRule(request, token, WARN)).toMatchObject({ enabled: false });
    await page.reload();
    await expectRuleState(row, 'Wind speed above 46 m/s', false);

    await ruleSwitch(row).click();
    await expect(page.getByTestId('rules-notice')).toHaveText(
      'Rule enabled: Wind speed above 46 m/s.',
    );
    await expectRuleState(row, 'Wind speed above 46 m/s', true);
    expect(await findRule(request, token, WARN)).toMatchObject({ enabled: true });
    await page.reload();
    await expectRuleState(row, 'Wind speed above 46 m/s', true);
    await expect(page.getByTestId('rules-toggle-error')).toHaveCount(0);
  });

  test('[DATA] a failed switch is pending while it runs, then rolls back and says why', async ({
    page,
    request,
  }) => {
    const token = await apiToken(request, 'owner');
    const rule = (await findRule(request, token, WARN))!;
    await openRules(page);
    const row = ruleRow(page, rule.id);
    const toggle = row.getByTestId('rule-enabled-toggle');

    // Hold the PATCH until the pending state is asserted, then answer 500.
    let release!: () => void;
    const released = new Promise<void>((resolve) => (release = resolve));
    await page.route(isRulePatch, async (route) => {
      if (route.request().method() !== 'PATCH') return route.fallback();
      await released;
      await route.fulfill({
        status: 500,
        json: { statusCode: 500, message: 'Internal server error' },
      });
    });

    await ruleSwitch(row).click();
    // Optimistic: shown off at once, the switch disabled until the request ends.
    await expect(toggle).toHaveAttribute('data-pending', 'true');
    await expect(ruleSwitch(row)).toHaveAttribute('aria-checked', 'false');
    await expect(ruleSwitch(row)).toBeDisabled();
    release();

    const error = page.getByTestId('rules-toggle-error');
    await expect(error).toHaveText(
      'Could not disable “Wind speed above 46 m/s”. Internal server error.',
    );
    await expect(error).toHaveRole('alert');
    await expect(toggle).not.toHaveAttribute('data-pending');
    await expectRuleState(row, 'Wind speed above 46 m/s', true);
    await expect(ruleSwitch(row)).toBeEnabled();
    await expect(page.getByTestId('rules-notice')).not.toHaveText(/Rule disabled/);
    expect(await findRule(request, token, WARN)).toMatchObject({ enabled: true });
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
    await markDocument(page);

    // Another user changes it (through the API): alert-config.changed → the list reloads.
    await updateRule(request, token, rule.id, { valueMetric: 47 });
    await expect(row.getByRole('cell').nth(2)).toHaveText('47 m/s');
    expect(await sameDocument(page)).toBe(true);
  });

  test('[DATA] a viewer sees whether a rule is enabled, but has no switch', async ({
    page,
    request,
  }) => {
    const token = await apiToken(request, 'owner');
    const rule = (await findRule(request, token, WARN))!;
    await openRules(page, 'viewer');
    const row = ruleRow(page, rule.id);
    await expect(page.getByRole('columnheader', { name: 'Enabled' })).toBeVisible();
    await expect(row.getByTestId('rule-enabled-state')).toHaveText('Enabled');
    await expect(row.getByTestId('rule-disabled')).toHaveCount(0);
    await expect(page.getByTestId('rule-enabled-toggle')).toHaveCount(0);
    await expect(page.getByRole('switch')).toHaveCount(0);

    await updateRule(request, token, rule.id, { enabled: false });
    await page.reload();
    await expect(row).toHaveAttribute('data-enabled', 'false');
    await expect(row.getByTestId('rule-disabled')).toHaveText('Disabled');
    await expect(row.getByTestId('rule-enabled-state')).toHaveCount(0);
    await expect(page.getByRole('switch')).toHaveCount(0);
    await updateRule(request, token, rule.id, { enabled: true });
  });

  test("[DATA] a viewer's open Rules page follows an owner's switch live", async ({
    page,
    browser,
    request,
  }) => {
    const rule = (await findRule(request, await apiToken(request, 'owner'), WARN))!;
    await openRules(page, 'viewer');
    const viewerRow = ruleRow(page, rule.id);
    await expect(viewerRow.getByTestId('rule-enabled-state')).toHaveText('Enabled');
    await markDocument(page);

    // The owner switches it off in another browser.
    const owner = await browser.newContext();
    try {
      const ownerPage = await owner.newPage();
      await openRules(ownerPage);
      const ownerRow = ruleRow(ownerPage, rule.id);
      await ruleSwitch(ownerRow).click();
      await expect(ownerPage.getByTestId('rules-notice')).toHaveText(
        'Rule disabled: Wind speed above 47 m/s.',
      );
      await expect(viewerRow).toHaveAttribute('data-enabled', 'false');
      await expect(viewerRow.getByTestId('rule-disabled')).toHaveText('Disabled');
      await expect(viewerRow.getByTestId('rule-enabled-state')).toHaveCount(0);

      await ruleSwitch(ownerRow).click();
      await expect(ownerPage.getByTestId('rules-notice')).toHaveText(
        'Rule enabled: Wind speed above 47 m/s.',
      );
      await expect(viewerRow.getByTestId('rule-enabled-state')).toHaveText('Enabled');
      await expect(viewerRow.getByTestId('rule-disabled')).toHaveCount(0);
    } finally {
      await owner.close();
    }
    expect(await sameDocument(page)).toBe(true);
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

/**
 * [DATA] A disabled rule isn't evaluated by ingestion (plan 7.7): readings uploaded while it is
 * off are stored unflagged, the next one after switching it on is flagged. Then the rule has
 * flagged readings, so it can't be deleted; once disabled, the delete dialog offers only Close.
 *
 * Re-runnable: the rule "Gearbox temperature below 5 °C → Info" fires only on this run's turbine
 * (`E2E-<run>-RF` on FARM04, readings Jan 2 22:45–22:55 with a 2 °C gearbox); no seed or demo
 * reading is that cold. ensureRule creates or re-enables it; afterAll disables it (it can't be
 * deleted once it flagged a reading). Left behind (no turbine/telemetry delete API): the
 * turbine, its three readings and the disabled rule.
 */
test.describe('[DATA] Disabled rules and ingestion', () => {
  test.describe.configure({ mode: 'serial' });

  const FARM = 'FARM04';
  const RULE: RuleInput = {
    measurementMetric: 'gearboxTempC',
    comparison: 'below',
    valueMetric: 5,
    alertLevel: 'info',
  };
  const RULE_TEXT = 'Gearbox temperature below 5 °C';
  const COLD = { gearboxTempC: 2 };
  let turbine = '';
  let ruleId = '';
  let cleanupRule: ((request: APIRequestContext) => Promise<void>) | undefined;

  test.beforeAll(async ({ request }) => {
    turbine = `E2E-${Date.now().toString(36).toUpperCase()}-RF`;
    const token = await apiToken(request, 'owner');
    const ensured = await ensureRule(request, token, RULE);
    ruleId = ensured.rule.id;
    cleanupRule = ensured.cleanup;
    await createTurbine(request, token, turbine, FARM, [{ timestamp: '2026-01-02T22:45:00Z' }]);
  });

  test.afterAll(async ({ request }) => {
    await cleanupRule?.(request);
    await removeUnallocated(
      request,
      await apiToken(request, 'owner'),
      (e) => e.turbineId === turbine,
    );
  });

  async function switchRule(page: Page, enable: boolean): Promise<void> {
    await page.goto('/alerting/rules');
    const row = ruleRow(page, ruleId);
    await expectRuleState(row, RULE_TEXT, !enable);
    await ruleSwitch(row).click();
    await expect(page.getByTestId('rules-notice')).toHaveText(
      `Rule ${enable ? 'enabled' : 'disabled'}: ${RULE_TEXT}.`,
    );
    await expectRuleState(row, RULE_TEXT, enable);
  }

  /** The turbine page's readings table: newest first, one Alerts cell per reading. */
  async function openTurbine(page: Page, readings: number): Promise<void> {
    await page.goto(`/farms/${FARM}/turbines/${turbine}`);
    await expect(page.getByTestId('history').getByRole('row')).toHaveCount(readings + 1);
  }

  /** History (default Jan 2–3) once loaded: this turbine's summary row. */
  async function historyRow(page: Page) {
    await page.goto('/alerting/history');
    await expect(page.getByTestId('history-count')).toHaveText(/flagged readings?|No alerts/);
    return page.locator(`[data-testid="history-turbine"][data-turbine-id="${turbine}"]`);
  }

  test('[DATA] a disabled rule doesn’t flag a new reading; switched on, the next one is flagged', async ({
    page,
    request,
  }) => {
    await signIn(page, 'owner');
    await switchRule(page, false);

    expect(
      await uploadTelemetry(request, [
        { turbineId: turbine, farmId: FARM, timestamp: '2026-01-02T22:50:00Z', ...COLD },
      ]),
    ).toMatchObject({ rows: 1, inserted: 1 });
    await openTurbine(page, 2);
    const rows = page.getByTestId('history').getByRole('row');
    await expect(rows.nth(1).getByRole('cell').first()).toHaveText('Jan 2, 22:50');
    await expect(page.getByTestId('reading-alerts')).toHaveText(['–', '–']);
    await expect(await historyRow(page)).toHaveCount(0);

    await switchRule(page, true);
    expect(
      await uploadTelemetry(request, [
        { turbineId: turbine, farmId: FARM, timestamp: '2026-01-02T22:55:00Z', ...COLD },
      ]),
    ).toMatchObject({ rows: 1, inserted: 1 });
    await openTurbine(page, 3);
    await expect(rows.nth(1).getByRole('cell').first()).toHaveText('Jan 2, 22:55');
    await expect(page.getByTestId('reading-alerts').nth(1)).toHaveText('–');
    await expect(
      rows.nth(1).getByTestId('alerts-cell-trigger').getByTestId('level-count'),
    ).toHaveText(['Info: 1']);

    // History lists only the 22:55 reading, with the rule's chip.
    const row = await historyRow(page);
    await expect(row.getByTestId('level-count')).toHaveText(['Info: 1']);
    await row.getByRole('button', { name: `Show readings for ${turbine}` }).click();
    const reading = page
      .getByRole('list', { name: `Readings for ${turbine}` })
      .getByTestId('history-reading');
    await expect(reading).toHaveCount(1);
    await expect(reading).toContainText('Jan 2, 22:55');
    await expect(reading.getByTestId('alert-chip')).toHaveText([
      'Info: Gearbox temperature 2 °C < 5',
    ]);
  });

  test('[DATA] deleting a triggered rule that is already disabled offers only Close', async ({
    page,
    request,
  }) => {
    const token = await apiToken(request, 'owner');
    await updateRule(request, token, ruleId, { enabled: false });
    await signIn(page, 'owner');
    await page.goto('/alerting/rules');
    const row = ruleRow(page, ruleId);
    await expectRuleState(row, RULE_TEXT, false);

    await row.getByRole('button', { name: `Delete rule: ${RULE_TEXT}` }).click();
    const dialog = page.getByTestId('delete-dialog');
    await dialog.getByTestId('confirm-delete').click();
    await expect(dialog.getByRole('heading')).toHaveText('This rule can’t be deleted');
    await expect(dialog.getByTestId('delete-triggered')).toHaveText(
      'This rule has flagged readings, so it can’t be deleted — they keep their history. It’s already disabled, so it isn’t evaluated.',
    );
    await expect(dialog.getByRole('button')).toHaveText(['Close']);
    await expect(dialog.getByTestId('close-delete')).toBeFocused();
    await expect(dialog.getByTestId('disable-rule')).toHaveCount(0);
    await expect(dialog.getByTestId('confirm-delete')).toHaveCount(0);

    await dialog.getByTestId('close-delete').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('rules-notice')).toHaveText('');
    await expectRuleState(row, RULE_TEXT, false);
    expect(await findRule(request, token, RULE)).toMatchObject({ id: ruleId, enabled: false });
  });
});
