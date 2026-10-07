import { TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { TEST_API_BASE_URL, openFleet } from '../fleet/testing';
import { AlertConfig } from './alert-config.model';

const URL = `${TEST_API_BASE_URL}/alert-configs`;

const rule = (overrides: Partial<AlertConfig> = {}): AlertConfig => ({
  id: crypto.randomUUID(),
  measurementMetric: 'gearboxTempC',
  comparison: 'above',
  valueMetric: 120,
  alertLevel: 'error',
  enabled: true,
  ...overrides,
});

/** /alerting/rules through the real routes, with the real AlertConfigApi on HttpTestingController. */
describe('AlertRulesPage (/alerting/rules)', () => {
  let app: Awaited<ReturnType<typeof openFleet>>;
  afterEach(() => app.http.verify());

  async function open(rules: AlertConfig[] = []) {
    app = await openFleet('/alerting/rules', () => Date.parse('2026-01-03T00:00:00.000Z'));
    await flushList(rules);
  }
  /**
   * Stable, including MatDialog's close (its `afterClosed` arrives a task after the close, even
   * without animations).
   */
  async function settle() {
    await app.stable();
    await new Promise((resolve) => setTimeout(resolve));
    await app.stable();
  }
  async function flushList(rules: AlertConfig[]) {
    app.http.expectOne({ method: 'GET', url: URL }).flush(rules);
    await settle();
  }
  /**
   * This test's page, then its open dialogs: Material dialogs render in the CDK overlay container,
   * outside the app root (and earlier tests' app roots may still be in the document).
   */
  const q = <T extends Element = HTMLElement>(testId: string) =>
    app.root().querySelector<T & HTMLElement>(`[data-testid=${testId}]`) ??
    document.querySelector<T & HTMLElement>(`.cdk-overlay-container [data-testid=${testId}]`);
  const rows = () => [...app.root().querySelectorAll('[data-testid=rule]')];
  const cells = (row: Element) => [...row.querySelectorAll('td')].map((td) => app.text(td));
  const isOpen = (testId: string) => q(testId) !== null;
  /** The MatDialog container (role=dialog) of an open dialog. */
  const container = (testId: string) => q(testId)!.closest('mat-dialog-container')!;
  /** Esc in the focused dialog (MatDialog checks the legacy keyCode, which jsdom leaves at 0). */
  async function pressEscape() {
    const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true });
    Object.defineProperty(event, 'keyCode', { get: () => 27 });
    (document.activeElement ?? document.body).dispatchEvent(event);
    await settle();
  }
  async function click(testId: string, within?: Element) {
    (within ? within.querySelector<HTMLElement>(`[data-testid=${testId}]`) : q(testId))!.click();
    await settle();
  }
  async function choose(testId: string, value: string) {
    const select = q<HTMLSelectElement>(testId)!;
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await settle();
  }
  async function type(testId: string, value: string) {
    const input = q<HTMLInputElement>(testId)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await settle();
  }
  async function submit(testId: string) {
    q(testId)!.closest('form')!.requestSubmit();
    await settle();
  }
  const expectWrite = (method: string, url: string): TestRequest =>
    app.http.expectOne({ method, url });

  it('lists the rules with metric, unit, condition, threshold and level, under the Rules tab', async () => {
    await open([
      rule({
        measurementMetric: 'powerOutputKw',
        comparison: 'below',
        valueMetric: 50,
        alertLevel: 'info',
      }),
      rule({ measurementMetric: 'bladePitchDeg', valueMetric: 30, alertLevel: 'warn' }),
      rule({ valueMetric: 120.5 }),
    ]);

    expect(app.text(app.root().querySelector('h1'))).toBe('Alerting');
    expect(TestBed.inject(Title).getTitle()).toBe('Alert rules · Nextera');
    expect(rows().map(cells)).toEqual([
      [
        'Power output (kW)',
        'below',
        '50 kW',
        'Info',
        'Edit rule: Power output below 50 kW Delete rule: Power output below 50 kW',
      ],
      ['Blade pitch (°)', 'above', '30°', 'Warning', expect.stringContaining('Edit')],
      ['Gearbox temperature (°C)', 'above', '120.5 °C', 'Error', expect.stringContaining('Edit')],
    ]);
    expect(
      [...app.root().querySelectorAll('[data-testid=rule-level]')].map((b) =>
        b.getAttribute('data-level'),
      ),
    ).toEqual(['info', 'warn', 'error']);
    // Tabs: Rules is current; the side nav keeps Alerting current.
    expect(q('alerting-tab-rules')!.getAttribute('aria-current')).toBe('page');
    expect(q('alerting-tab-history')!.getAttribute('aria-current')).toBeNull();
    expect(q('alerting-tab-history')!.getAttribute('href')).toBe('/alerting/history');
    // The Active tab is gone: History and Rules only.
    expect(
      [...app.root().querySelectorAll('nav[aria-label=Alerting] a')].map((a) => app.text(a)),
    ).toEqual(['History', 'Rules']);
    expect(q('nav-alerting')!.getAttribute('aria-current')).toBe('page');
    // Material table, 25 rules per page.
    expect(q('rules')!.classList).toContain('mat-mdc-table');
    expect(app.text(q('rules-paginator')!.querySelector('.mat-mdc-paginator-range-label'))).toBe(
      '1 – 3 of 3',
    );
  });

  it('shows an empty state without rules', async () => {
    await open([]);
    expect(rows()).toHaveLength(0);
    expect(app.text(q('no-rules'))).toContain('No alert rules yet.');
  });

  it('shows a load error with a retry', async () => {
    app = await openFleet('/alerting/rules', () => 0);
    app.http.expectOne(URL).flush('boom', { status: 500, statusText: 'Server Error' });
    await settle();
    expect(app.text(q('rules-load-error'))).toContain('Could not load the alert rules.');

    q('rules-load-error')!.querySelector('button')!.click();
    await flushList([rule()]);
    expect(q('rules-load-error')).toBeNull();
    expect(rows()).toHaveLength(1);
  });

  it('adds a rule: posts it, closes the dialog, announces it and reloads', async () => {
    await open([]);
    await click('add-rule');
    expect(isOpen('rule-dialog')).toBe(true);
    expect(app.text(q('rule-dialog')!.querySelector('h2'))).toBe('Add alert rule');

    await choose('rule-metric', 'rotorRpm');
    await choose('rule-comparison', 'below');
    await type('rule-value', '2.5');
    await choose('rule-level-select', 'info');
    await submit('rule-save');

    const post = expectWrite('POST', URL);
    expect(post.request.body).toEqual({
      measurementMetric: 'rotorRpm',
      comparison: 'below',
      valueMetric: 2.5,
      alertLevel: 'info',
    });
    const created = rule({ ...post.request.body });
    post.flush(created, { status: 201, statusText: 'Created' });
    await settle();

    expect(isOpen('rule-dialog')).toBe(false);
    expect(app.text(q('rules-notice'))).toBe('Rule added: Rotor speed below 2.5 rpm.');
    await flushList([created]);
    expect(rows()).toHaveLength(1);
  });

  it('validates the threshold inline before sending anything', async () => {
    await open([]);
    await click('add-rule');
    await submit('rule-save');

    expect(app.text(q('rule-value-error'))).toBe('Enter a threshold value.');
    // Empty and required: Material leaves aria-invalid off and relies on aria-required plus the
    // announced <mat-error>.
    expect(q('rule-value')!.getAttribute('aria-required')).toBe('true');
    expect(q('rule-value')!.getAttribute('aria-invalid')).toBeNull();
    // The <mat-error> is announced with the field, after the unit.
    expect(q('rule-value')!.getAttribute('aria-describedby')!.split(' ')).toEqual([
      'rule-value-unit',
      q('rule-value-error')!.id,
    ]);
    expect(q('rule-value')!.closest('mat-form-field')!.classList).toContain(
      'mat-form-field-invalid',
    );
    expect(isOpen('rule-dialog')).toBe(true);
    app.http.expectNone(URL);

    await type('rule-value', '-5');
    expect(q('rule-value-error')).toBeNull();
    expect(q('rule-value')!.getAttribute('aria-invalid')).toBe('false');
    expect(q('rule-value')!.closest('mat-form-field')!.classList).not.toContain(
      'mat-form-field-invalid',
    );
  });

  it('shows a duplicate (409) in the dialog and keeps it open', async () => {
    await open([rule()]);
    await click('add-rule');
    await choose('rule-level-select', 'error');
    await type('rule-value', '130');
    await submit('rule-save');

    expectWrite('POST', URL).flush(
      {
        statusCode: 409,
        message: 'An alert rule for gearboxTempC above at level error already exists',
      },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();

    expect(app.text(q('rule-error'))).toBe(
      'An Error rule for “Gearbox temperature above” already exists. Edit that rule, or choose another condition or level.',
    );
    expect(q('rule-error')!.getAttribute('role')).toBe('alert');
    expect(isOpen('rule-dialog')).toBe(true);
    await flushList([rule()]); // reloaded: the other rule may have been added elsewhere
  });

  it('lists validation messages from a 400', async () => {
    await open([]);
    await click('add-rule');
    await type('rule-value', '1');
    await submit('rule-save');
    expectWrite('POST', URL).flush(
      {
        statusCode: 400,
        message: [
          'valueMetric must be a finite number',
          'alertLevel must be one of: info, warn, error',
        ],
      },
      { status: 400, statusText: 'Bad Request' },
    );
    await settle();
    expect(app.text(q('rule-error'))).toBe(
      'valueMetric must be a finite number. alertLevel must be one of: info, warn, error.',
    );
  });

  it('edits a rule: prefilled, then PATCHed', async () => {
    const existing = rule({
      measurementMetric: 'windSpeedMs',
      comparison: 'above',
      valueMetric: 25,
      alertLevel: 'warn',
    });
    await open([existing]);
    await click('edit-rule', rows()[0]);

    expect(app.text(q('rule-dialog')!.querySelector('h2'))).toBe('Edit alert rule');
    expect(q<HTMLSelectElement>('rule-metric')!.value).toBe('windSpeedMs');
    expect(q<HTMLSelectElement>('rule-level-select')!.value).toBe('warn');
    expect(q<HTMLInputElement>('rule-value')!.value).toBe('25');
    expect(app.text(q('rule-value')!.closest('mat-form-field'))).toContain('m/s');

    await type('rule-value', '28');
    await submit('rule-save');

    const patch = expectWrite('PATCH', `${URL}/${existing.id}`);
    expect(patch.request.body).toEqual({
      ...existing,
      id: undefined,
      enabled: undefined,
      valueMetric: 28,
    });
    // Editing never touches `enabled` (a disabled rule stays disabled).
    expect(Object.keys(patch.request.body)).not.toContain('enabled');
    patch.flush({ ...existing, valueMetric: 28 });
    await settle();
    expect(isOpen('rule-dialog')).toBe(false);
    expect(app.text(q('rules-notice'))).toBe('Rule updated: Wind speed above 28 m/s.');
    await flushList([{ ...existing, valueMetric: 28 }]);
  });

  it('shows other server errors in the dialog', async () => {
    await open([]);
    await click('add-rule');
    await type('rule-value', '1');
    await submit('rule-save');
    expectWrite('POST', URL).flush(
      { statusCode: 500, message: 'Internal server error' },
      { status: 500, statusText: 'Server Error' },
    );
    await settle();
    expect(app.text(q('rule-error'))).toBe('Internal server error.');
    expect(isOpen('rule-dialog')).toBe(true);
  });

  it('deletes a rule after confirmation', async () => {
    const existing = rule();
    await open([existing]);

    await click('delete-rule', rows()[0]);
    expect(isOpen('delete-dialog')).toBe(true);
    expect(app.text(q('delete-dialog'))).toContain(
      'Gearbox temperature above 120 °C (Error) will be removed.',
    );

    // Cancel first (focused initially): nothing is deleted.
    expect(app.text(document.activeElement)).toBe('Cancel');
    await pressEscape();
    expect(isOpen('delete-dialog')).toBe(false);
    app.http.expectNone(`${URL}/${existing.id}`);

    await click('delete-rule', rows()[0]);
    await click('confirm-delete');
    expectWrite('DELETE', `${URL}/${existing.id}`).flush(null, {
      status: 204,
      statusText: 'No Content',
    });
    await settle();

    expect(isOpen('delete-dialog')).toBe(false);
    expect(app.text(q('rules-notice'))).toBe('Rule deleted: Gearbox temperature above 120 °C.');
    await flushList([]);
    expect(q('no-rules')).not.toBeNull();
  });

  it('keeps the delete dialog open with the reason from the API when the rule cannot be deleted (409)', async () => {
    const existing = rule();
    await open([existing]);
    await click('delete-rule', rows()[0]);
    await click('confirm-delete');
    expectWrite('DELETE', `${URL}/${existing.id}`).flush(
      {
        message: `Alert config ${existing.id} has triggered alerts on telemetry readings and cannot be deleted; disable it instead (enabled: false)`,
      },
      { status: 409, statusText: 'Conflict' },
    );
    await settle();

    expect(isOpen('delete-dialog')).toBe(true);
    expect(app.text(q('delete-error'))).toContain('has triggered alerts on telemetry readings');
    expect(q<HTMLButtonElement>('confirm-delete')!.disabled).toBe(false);
    app.http.expectNone(URL); // nothing changed: no reload
  });

  it('treats deleting a rule that is already gone (404) as done', async () => {
    const existing = rule();
    await open([existing]);
    await click('delete-rule', rows()[0]);
    await click('confirm-delete');
    expectWrite('DELETE', `${URL}/${existing.id}`).flush(
      { message: `Alert config ${existing.id} not found` },
      { status: 404, statusText: 'Not Found' },
    );
    await settle();

    expect(isOpen('delete-dialog')).toBe(false);
    await flushList([]);
  });

  it('reloads the list when another browser changes a rule (alert-config.changed over SSE)', async () => {
    await open([]);
    const added = rule();
    app.sse.pushEvent('alert-config.changed', { action: 'created', id: added.id });
    await settle();

    await flushList([added]);
    expect(rows()).toHaveLength(1);
  });

  it('closes the editor on Esc and returns focus to the button that opened it', async () => {
    await open([]);
    const add = q('add-rule')!;
    add.focus();
    await click('add-rule');
    expect(document.activeElement).toBe(q('rule-metric')); // MatDialog: first tabbable field

    await pressEscape();

    expect(isOpen('rule-dialog')).toBe(false);
    expect(document.activeElement).toBe(add);
  });

  it('labels every field of the editor', async () => {
    await open([]);
    await click('add-rule');
    const dialog = q('rule-dialog')!;
    // MatDialog: role=dialog + aria-modal, labelled by the mat-dialog-title.
    const box = container('rule-dialog');
    expect([box.getAttribute('role'), box.getAttribute('aria-modal')]).toEqual(['dialog', 'true']);
    expect(box.getAttribute('aria-labelledby')).toBe(dialog.querySelector('h2')!.id);
    // mat-form-field renders a <label for> per control from its <mat-label>.
    const label = (id: string) => app.text(dialog.querySelector(`label[for="${q(id)!.id}"]`));
    expect(
      ['rule-metric', 'rule-comparison', 'rule-value', 'rule-level-select'].map(label),
    ).toEqual(['Metric', 'Condition', 'Threshold', 'Level']);
  });
});
