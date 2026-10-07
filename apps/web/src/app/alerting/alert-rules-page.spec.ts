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
  async function flushList(rules: AlertConfig[]) {
    app.http.expectOne({ method: 'GET', url: URL }).flush(rules);
    await app.stable();
  }
  const q = <T extends Element = HTMLElement>(testId: string) =>
    app.root().querySelector<T & HTMLElement>(`[data-testid=${testId}]`);
  const rows = () => [...app.root().querySelectorAll('[data-testid=rule]')];
  const cells = (row: Element) => [...row.querySelectorAll('td')].map((td) => app.text(td));
  const isOpen = (testId: string) => q(testId)!.hasAttribute('open');
  async function click(testId: string, within: Element | null = app.root()) {
    within!.querySelector<HTMLElement>(`[data-testid=${testId}]`)!.click();
    await app.stable();
  }
  async function choose(testId: string, value: string) {
    const select = q<HTMLSelectElement>(testId)!;
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await app.stable();
  }
  async function type(testId: string, value: string) {
    const input = q<HTMLInputElement>(testId)!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await app.stable();
  }
  async function submit(testId: string) {
    q(testId)!.closest('form')!.requestSubmit();
    await app.stable();
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
    expect(q('alerting-tab-active')!.getAttribute('aria-current')).toBeNull();
    expect(q('alerting-tab-active')!.getAttribute('href')).toBe('/alerting');
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
    await app.stable();
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
    await app.stable();

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
    expect(q('rule-value')!.getAttribute('aria-invalid')).toBe('true');
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
    await app.stable();

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
    await app.stable();
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
    expect(patch.request.body).toEqual({ ...existing, id: undefined, valueMetric: 28 });
    patch.flush({ ...existing, valueMetric: 28 });
    await app.stable();
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
    await app.stable();
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

    // Cancel first: nothing is deleted.
    q('delete-dialog')!.dispatchEvent(new Event('cancel'));
    await app.stable();
    expect(isOpen('delete-dialog')).toBe(false);
    app.http.expectNone(`${URL}/${existing.id}`);

    await click('delete-rule', rows()[0]);
    await click('confirm-delete');
    expectWrite('DELETE', `${URL}/${existing.id}`).flush(null, {
      status: 204,
      statusText: 'No Content',
    });
    await app.stable();

    expect(isOpen('delete-dialog')).toBe(false);
    expect(app.text(q('rules-notice'))).toBe('Rule deleted: Gearbox temperature above 120 °C.');
    await flushList([]);
    expect(q('no-rules')).not.toBeNull();
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
    await app.stable();

    expect(isOpen('delete-dialog')).toBe(false);
    await flushList([]);
  });

  it('reloads the list when another browser changes a rule (alert-config.changed over SSE)', async () => {
    await open([]);
    const added = rule();
    app.sse.pushEvent('alert-config.changed', { action: 'created', id: added.id });
    await app.stable();

    await flushList([added]);
    expect(rows()).toHaveLength(1);
  });

  it('closes the editor on Esc and returns focus to the button that opened it', async () => {
    await open([]);
    const add = q('add-rule')!;
    add.focus();
    await click('add-rule');
    expect(document.activeElement).toBe(q('rule-metric')); // [autofocus]

    q('rule-dialog')!.dispatchEvent(new Event('cancel'));
    await app.stable();

    expect(isOpen('rule-dialog')).toBe(false);
    expect(document.activeElement).toBe(add);
  });

  it('labels every field of the editor', async () => {
    await open([]);
    await click('add-rule');
    const dialog = q('rule-dialog')!;
    expect(dialog.getAttribute('aria-labelledby')).toBe(dialog.querySelector('h2')!.id);
    // mat-form-field renders a <label for> per control from its <mat-label>.
    const label = (id: string) => app.text(dialog.querySelector(`label[for="${q(id)!.id}"]`));
    expect(
      ['rule-metric', 'rule-comparison', 'rule-value', 'rule-level-select'].map(label),
    ).toEqual(['Metric', 'Condition', 'Threshold', 'Level']);
  });
});
