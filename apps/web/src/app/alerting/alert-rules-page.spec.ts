import { TestRequest } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { Title } from '@angular/platform-browser';
import { TEST_API_BASE_URL, openFleet } from '../fleet/testing';
import { Role } from '../core/auth/roles';
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

  async function open(rules: AlertConfig[] = [], role: Role = 'admin') {
    app = await openFleet(
      '/alerting/rules',
      () => Date.parse('2026-01-03T00:00:00.000Z'),
      undefined,
      undefined,
      role,
    );
    await flushList(rules);
  }
  /**
   * Rendered, including MatDialog's close (its `afterClosed` arrives a task after the close, even
   * without animations) and a resource's answer (committed a microtask after it arrives). Ticks
   * instead of `whenStable()`: the rules resource is a pending task while a request is open.
   */
  async function settle() {
    TestBed.tick();
    await new Promise((resolve) => setTimeout(resolve));
    TestBed.tick();
  }
  async function flushList(rules: AlertConfig[]) {
    TestBed.tick(); // the resource sends its request on change detection
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
    // A browser fires both; Signal Forms reads a native select on `input`.
    select.dispatchEvent(new Event('input'));
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
        '', // the Enabled switch: named by aria-label
        'Edit rule: Power output below 50 kW Delete rule: Power output below 50 kW',
      ],
      ['Blade pitch (°)', 'above', '30°', 'Warning', '', expect.stringContaining('Edit')],
      [
        'Gearbox temperature (°C)',
        'above',
        '120.5 °C',
        'Error',
        '',
        expect.stringContaining('Edit'),
      ],
    ]);
    expect([...q('rules')!.querySelectorAll('thead th')].map((th) => app.text(th))).toEqual([
      'Metric',
      'Condition',
      'Threshold',
      'Level',
      'Enabled',
      'Actions',
    ]);
    expect(
      [...app.root().querySelectorAll('[data-testid=rule-level]')].map((b) =>
        b.getAttribute('data-level'),
      ),
    ).toEqual(['info', 'warn', 'error']);
    // Tabs (Material tab nav bar, tablist "Alerting"): Rules is selected and the page is in the
    // tab panel; the side nav keeps Alerting current.
    expect(q('alerting-tabs')!.getAttribute('role')).toBe('tablist');
    expect(q('alerting-tab-rules')!.getAttribute('aria-selected')).toBe('true');
    expect(q('alerting-tab-history')!.getAttribute('aria-selected')).toBe('false');
    expect(q('alerting-tab-rules')!.hasAttribute('aria-current')).toBe(false);
    expect(q('alerting-tab-history')!.getAttribute('href')).toBe('/alerting/history');
    expect(q('alerting-tab-panel')!.getAttribute('aria-labelledby')).toBe(
      q('alerting-tab-rules')!.id,
    );
    expect(q('alerting-tab-panel')!.contains(q('rules'))).toBe(true);
    // The Active tab is gone: History and Rules only.
    expect(
      [...app.root().querySelectorAll('nav[aria-label=Alerting] a')].map((a) => app.text(a)),
    ).toEqual(['History', 'Rules', 'Anomalies']);
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
    TestBed.tick();
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
      enabled: true, // on by default
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
    const { id: _id, ...fields } = existing;
    expect(patch.request.body).toEqual({ ...fields, valueMetric: 28 }); // `enabled` as prefilled
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

  it('says the API is unreachable when saving fails on the network, keeps the dialog open and the list as is', async () => {
    await open([]);
    await click('add-rule');
    await type('rule-value', '130');
    await submit('rule-save');

    expectWrite('POST', URL).error(new ProgressEvent('error'));
    await settle();

    expect(app.text(q('rule-error'))).toBe(
      'Could not reach the API. Check your connection and try again.',
    );
    expect(isOpen('rule-dialog')).toBe(true);
    expect(q<HTMLInputElement>('rule-value')!.value).toBe('130'); // nothing typed is lost
    expect(q('rules-notice')?.textContent?.trim() ?? '').toBe('');
    app.http.expectNone({ method: 'GET', url: URL }); // no reload: nothing changed
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

  /** DELETE answers 409: readings triggered the rule (the API's text names its internal id). */
  const flushTriggered = (req: TestRequest, id: string) =>
    req.flush(
      {
        statusCode: 409,
        message: `Alert config ${id} has triggered alerts on telemetry readings and cannot be deleted; disable it instead (enabled: false)`,
      },
      { status: 409, statusText: 'Conflict' },
    );

  it('explains in words why a rule that flagged readings cannot be deleted, and disables it instead', async () => {
    const existing = rule();
    await open([existing]);
    await click('delete-rule', rows()[0]);
    await click('confirm-delete');
    flushTriggered(expectWrite('DELETE', `${URL}/${existing.id}`), existing.id);
    await settle();

    expect(isOpen('delete-dialog')).toBe(true);
    expect(app.text(q('delete-dialog')!.querySelector('h2'))).toBe('This rule can’t be deleted');
    expect(app.text(q('delete-triggered'))).toBe(
      'This rule has flagged readings, so it can’t be deleted — they keep their history. ' +
        'Disable it instead to stop it from being evaluated.',
    );
    expect(q('delete-triggered')!.getAttribute('role')).toBe('alert');
    // Never the API's text or the internal id.
    expect(app.text(q('delete-dialog'))).not.toContain(existing.id);
    expect(app.text(q('delete-dialog'))).not.toContain('enabled: false');
    expect(q('delete-error')).toBeNull();
    expect(q('confirm-delete')).toBeNull(); // Delete is replaced by Disable rule
    expect(document.activeElement).toBe(q('disable-rule'));
    app.http.expectNone(URL); // nothing changed: no reload

    await click('disable-rule');
    expect(app.text(q('disable-rule'))).toBe('Disabling…');
    const patch = expectWrite('PATCH', `${URL}/${existing.id}`);
    expect(patch.request.body).toEqual({ enabled: false });
    patch.flush({ ...existing, enabled: false });
    await settle();

    expect(isOpen('delete-dialog')).toBe(false);
    expect(app.text(q('rules-notice'))).toBe('Rule disabled: Gearbox temperature above 120 °C.');
    await flushList([{ ...existing, enabled: false }]);
    expect(rows()[0].getAttribute('data-enabled')).toBe('false');
    expect(app.text(rows()[0].querySelector('[data-testid=rule-disabled]'))).toBe('Disabled');
  });

  it('only offers Close when the rule that flagged readings is already disabled', async () => {
    const existing = rule({ enabled: false });
    await open([existing]);
    await click('delete-rule', rows()[0]);
    await click('confirm-delete');
    flushTriggered(expectWrite('DELETE', `${URL}/${existing.id}`), existing.id);
    await settle();

    expect(app.text(q('delete-triggered'))).toBe(
      'This rule has flagged readings, so it can’t be deleted — they keep their history. ' +
        'It’s already disabled, so it isn’t evaluated.',
    );
    expect(q('disable-rule')).toBeNull();
    expect(
      [...q('delete-dialog')!.querySelectorAll('mat-dialog-actions button')].map((b) =>
        app.text(b),
      ),
    ).toEqual(['Close']);
    expect(document.activeElement).toBe(q('close-delete'));

    await click('close-delete');
    expect(isOpen('delete-dialog')).toBe(false);
    expect(q('rules-notice')?.textContent?.trim()).toBe('');
    app.http.expectNone(URL);
  });

  it('keeps the dialog open with the reason when disabling instead fails', async () => {
    const existing = rule();
    await open([existing]);
    await click('delete-rule', rows()[0]);
    await click('confirm-delete');
    flushTriggered(expectWrite('DELETE', `${URL}/${existing.id}`), existing.id);
    await settle();
    await click('disable-rule');
    expectWrite('PATCH', `${URL}/${existing.id}`).error(new ProgressEvent('error'));
    await settle();

    expect(isOpen('delete-dialog')).toBe(true);
    expect(app.text(q('delete-error'))).toBe(
      'Could not disable the rule. Could not reach the API. Check your connection and try again.',
    );
    expect(q<HTMLButtonElement>('disable-rule')!.disabled).toBe(false);
  });

  it('closes the dialog when the rule to disable is gone (404)', async () => {
    const existing = rule();
    await open([existing]);
    await click('delete-rule', rows()[0]);
    await click('confirm-delete');
    flushTriggered(expectWrite('DELETE', `${URL}/${existing.id}`), existing.id);
    await settle();
    await click('disable-rule');
    expectWrite('PATCH', `${URL}/${existing.id}`).flush(
      { message: `Alert config ${existing.id} not found` },
      { status: 404, statusText: 'Not Found' },
    );
    await settle();
    expect(isOpen('delete-dialog')).toBe(false);
    await flushList([]);
  });

  it('shows other delete failures in the dialog and keeps Delete', async () => {
    const existing = rule();
    await open([existing]);
    await click('delete-rule', rows()[0]);
    await click('confirm-delete');
    expectWrite('DELETE', `${URL}/${existing.id}`).flush(
      { statusCode: 500, message: 'Internal server error' },
      { status: 500, statusText: 'Server Error' },
    );
    await settle();
    expect(app.text(q('delete-error'))).toBe('Internal server error.');
    expect(q<HTMLButtonElement>('confirm-delete')!.disabled).toBe(false);
    expect(q('delete-triggered')).toBeNull();
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

  it('lays the editor fields out in a grid inside the dialog content, not on it', async () => {
    await open([]);
    await click('add-rule');
    // Material's unlayered `.mat-mdc-dialog-content { display: block }` beats a Tailwind `grid`
    // class on mat-dialog-content (the fields stacked without gaps). jsdom applies no CSS, so this
    // pins the structure; the layout itself is checked in a browser.
    const fields = q('rule-fields')!;
    expect(fields.tagName).toBe('DIV');
    expect(fields.parentElement!.tagName).toBe('MAT-DIALOG-CONTENT');
    const cell = (id: string) => q(id)!.closest('mat-form-field')!.parentElement;
    for (const id of ['rule-metric', 'rule-comparison', 'rule-value', 'rule-level-select']) {
      expect(cell(id)).toBe(fields);
    }
  });

  describe('Enabled', () => {
    /** A row's switch (mat-slide-toggle renders a button with role=switch). */
    const toggle = (row: Element) =>
      row.querySelector<HTMLButtonElement>('[data-testid=rule-enabled-toggle] button[role=switch]');
    const state = (row: Element) => ({
      checked: toggle(row)?.getAttribute('aria-checked'),
      label: toggle(row)?.getAttribute('aria-label'),
      disabled: toggle(row)?.disabled,
      row: row.getAttribute('data-enabled'),
      pill: app.text(row.querySelector('[data-testid=rule-disabled]')) ?? '',
    });

    it('gives owners a switch per rule, named by what it does, and marks disabled rules', async () => {
      const off = rule({
        measurementMetric: 'powerOutputKw',
        comparison: 'below',
        valueMetric: 100,
      });
      await open([rule(), { ...off, enabled: false }], 'owner');

      expect(rows().map(state)).toEqual([
        {
          checked: 'true',
          label: 'Disable Gearbox temperature above 120 °C',
          disabled: false,
          row: 'true',
          pill: '',
        },
        {
          checked: 'false',
          label: 'Enable Power output below 100 kW',
          disabled: false,
          row: 'false',
          pill: 'Disabled',
        },
      ]);
      expect(q('rule-enabled-state')).toBeNull();
    });

    it('shows viewers the state in words, without a switch', async () => {
      await open(
        [rule(), rule({ valueMetric: 130, alertLevel: 'warn', enabled: false })],
        'viewer',
      );

      expect(app.root().querySelector('[data-testid=rule-enabled-toggle]')).toBeNull();
      expect(q('edit-rule')).toBeNull();
      expect(rows().map((row) => cells(row)[4])).toEqual(['Enabled', 'Disabled']);
      expect(app.text(rows()[0].querySelector('[data-testid=rule-enabled-state]'))).toBe('Enabled');
      expect(app.text(rows()[1].querySelector('[data-testid=rule-disabled]'))).toBe('Disabled');
      expect(rows()[1].getAttribute('data-enabled')).toBe('false');
    });

    it('switches a rule off at once (PATCH enabled), locked until the API answers, then announces it', async () => {
      const existing = rule();
      await open([existing], 'owner');

      toggle(rows()[0])!.click();
      await settle();
      // Optimistic: shown off and locked while the request runs.
      expect(state(rows()[0])).toEqual({
        checked: 'false',
        label: 'Enable Gearbox temperature above 120 °C',
        disabled: true,
        row: 'false',
        pill: 'Disabled',
      });
      expect(rows()[0].querySelector('[data-pending]')).not.toBeNull();
      const patch = expectWrite('PATCH', `${URL}/${existing.id}`);
      expect(patch.request.body).toEqual({ enabled: false });
      patch.flush({ ...existing, enabled: false });
      await settle();

      expect(state(rows()[0])).toMatchObject({ checked: 'false', disabled: false, row: 'false' });
      expect(app.text(q('rules-notice'))).toBe('Rule disabled: Gearbox temperature above 120 °C.');
      await flushList([{ ...existing, enabled: false }]);

      toggle(rows()[0])!.click();
      await settle();
      expect(state(rows()[0])).toMatchObject({ checked: 'true', disabled: true, pill: '' });
      const enable = expectWrite('PATCH', `${URL}/${existing.id}`);
      expect(enable.request.body).toEqual({ enabled: true });
      enable.flush(existing);
      await settle();
      expect(app.text(q('rules-notice'))).toBe('Rule enabled: Gearbox temperature above 120 °C.');
      await flushList([existing]);
      expect(state(rows()[0])).toMatchObject({ checked: 'true', disabled: false, row: 'true' });
    });

    it('rolls the switch back and says why when the change fails', async () => {
      const existing = rule();
      await open([existing], 'owner');

      toggle(rows()[0])!.click();
      await settle();
      expectWrite('PATCH', `${URL}/${existing.id}`).error(new ProgressEvent('error'));
      await settle();

      expect(state(rows()[0])).toEqual({
        checked: 'true',
        label: 'Disable Gearbox temperature above 120 °C',
        disabled: false,
        row: 'true',
        pill: '',
      });
      expect(app.text(q('rules-toggle-error'))).toBe(
        'Could not disable “Gearbox temperature above 120 °C”. ' +
          'Could not reach the API. Check your connection and try again.',
      );
      expect(q('rules-toggle-error')!.getAttribute('role')).toBe('alert');
      expect(q('rules-notice')?.textContent?.trim()).toBe('');
      await flushList([existing]); // reloaded: it may have changed elsewhere

      // The next change clears the error.
      toggle(rows()[0])!.click();
      await settle();
      expect(q('rules-toggle-error')).toBeNull();
      expectWrite('PATCH', `${URL}/${existing.id}`).flush({ ...existing, enabled: false });
      await settle();
      await flushList([{ ...existing, enabled: false }]);
    });

    it('says a rule deleted elsewhere is gone, without its id', async () => {
      const existing = rule({ enabled: false });
      await open([existing], 'owner');

      toggle(rows()[0])!.click();
      await settle();
      expectWrite('PATCH', `${URL}/${existing.id}`).flush(
        { message: `Alert config ${existing.id} not found` },
        { status: 404, statusText: 'Not Found' },
      );
      await settle();

      expect(app.text(q('rules-toggle-error'))).toBe(
        'Could not enable “Gearbox temperature above 120 °C”. ' +
          'This rule no longer exists: it was deleted elsewhere.',
      );
      expect(state(rows()[0]).checked).toBe('false'); // rolled back
      await flushList([]);
      expect(q('no-rules')).not.toBeNull();
    });

    it('follows changes made in another browser (alert-config.changed)', async () => {
      const existing = rule();
      await open([existing], 'owner');

      app.sse.pushEvent('alert-config.changed', { action: 'updated', id: existing.id });
      await settle();
      await flushList([{ ...existing, enabled: false }]);

      expect(state(rows()[0])).toEqual({
        checked: 'false',
        label: 'Enable Gearbox temperature above 120 °C',
        disabled: false,
        row: 'false',
        pill: 'Disabled',
      });
    });
  });

  describe('editor: Enabled', () => {
    const editorSwitch = () =>
      q('rule-enabled')!.querySelector<HTMLButtonElement>('button[role=switch]')!;

    it('is on for a new rule and sends what is chosen', async () => {
      await open([]);
      await click('add-rule');
      expect(editorSwitch().getAttribute('aria-checked')).toBe('true');
      expect(app.text(q('rule-enabled'))).toBe('Enabled');
      // Labelled by its text, described by the hint.
      const describedBy = editorSwitch().getAttribute('aria-describedby')!;
      expect(app.text(document.getElementById(describedBy))).toBe(
        'Disabled rules are kept, but new readings aren’t checked against them.',
      );

      editorSwitch().click();
      await settle();
      expect(editorSwitch().getAttribute('aria-checked')).toBe('false');
      await type('rule-value', '110');
      await submit('rule-save');

      const post = expectWrite('POST', URL);
      expect(post.request.body).toMatchObject({ valueMetric: 110, enabled: false });
      post.flush(rule({ ...post.request.body }), { status: 201, statusText: 'Created' });
      await settle();
      await flushList([rule({ valueMetric: 110, enabled: false })]);
    });

    it('is prefilled when editing and sent in the PATCH', async () => {
      const existing = rule({ enabled: false });
      await open([existing]);
      await click('edit-rule', rows()[0]);
      expect(editorSwitch().getAttribute('aria-checked')).toBe('false');

      editorSwitch().click();
      await settle();
      await submit('rule-save');
      const patch = expectWrite('PATCH', `${URL}/${existing.id}`);
      expect(patch.request.body).toMatchObject({ enabled: true, valueMetric: 120 });
      patch.flush({ ...existing, enabled: true });
      await settle();
      await flushList([{ ...existing, enabled: true }]);
    });

    it('says a rule deleted elsewhere while editing is gone, without its id', async () => {
      const existing = rule();
      await open([existing]);
      await click('edit-rule', rows()[0]);
      await submit('rule-save');
      expectWrite('PATCH', `${URL}/${existing.id}`).flush(
        { message: `Alert config ${existing.id} not found` },
        { status: 404, statusText: 'Not Found' },
      );
      await settle();
      expect(app.text(q('rule-error'))).toBe(
        'This rule no longer exists: it was deleted elsewhere.',
      );
      expect(isOpen('rule-dialog')).toBe(true);
      await flushList([]);
    });
  });
});
