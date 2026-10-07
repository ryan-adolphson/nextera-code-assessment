import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { MatTooltipHarness } from '@angular/material/tooltip/testing';
import { AlertConfig } from '../alerting/alert-config.model';
import { TEST_API_BASE_URL, mixedFleetFixture, openFleet, reading } from './testing';

const RULES_URL = `${TEST_API_BASE_URL}/alert-configs`;

/** /turbines through the real routes, with the mixed fleet at 2026-01-03T00:00Z. */
describe('TurbineList (/turbines)', () => {
  const CLOCK = Date.parse('2026-01-03T00:00:00.000Z');
  let app: Awaited<ReturnType<typeof openFleet>>;
  beforeEach(async () => {
    app = await openFleet('/turbines', () => CLOCK, mixedFleetFixture());
    await flushRules([]); // no alert rules unless a test loads some
  });
  afterEach(() => app.http.verify());

  async function flushRules(rules: AlertConfig[]) {
    app.http.expectOne({ method: 'GET', url: RULES_URL }).flush(rules);
    await app.stable();
  }

  const table = () => app.root().querySelector('[data-testid=turbines]')!;
  const rows = () => [...table().querySelectorAll('tbody tr[data-turbine-id]')];
  const ids = () => rows().map((r) => r.getAttribute('data-turbine-id'));
  const cells = (row: Element) => [...row.querySelectorAll('td')].map((td) => app.text(td));
  const sortButton = (key: string) =>
    app.root().querySelector<HTMLButtonElement>(`[data-testid=sort-${key}]`)!;
  const sortedColumns = () =>
    [...table().querySelectorAll('th[aria-sort]')].map((th) => [
      app.text(th.querySelector('button')),
      th.getAttribute('aria-sort'),
    ]);
  async function sortBy(key: string) {
    sortButton(key).click();
    await app.stable();
  }
  async function filter(value: string) {
    const input = app.root().querySelector<HTMLInputElement>('[data-testid=turbine-filter]')!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await app.stable();
  }
  async function status(value: string) {
    const select = app.root().querySelector<HTMLSelectElement>('[data-testid=status-filter]')!;
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await app.stable();
  }

  it('lists every turbine of every farm by turbine id, with status and latest reading', () => {
    expect(app.text(app.root().querySelector('h1'))).toBe('Turbines');
    expect(ids()).toEqual([
      'TURB001',
      'TURB002',
      'TURB003',
      'TURB004',
      'TURB005',
      'TURB006',
      'TURB007',
    ]);
    expect(cells(rows()[0])).toEqual([
      'TURB001',
      'Prairie Ridge FARM01',
      'Reporting',
      'Commissioned',
      'None',
      '1,961',
      '6.7',
      '80.0',
      'Jan 2, 23:55',
    ]);
    expect(cells(rows()[3])).toEqual([
      'TURB004',
      'High Plains FARM02',
      'No readings yet',
      'Not commissioned',
      '—',
      '–',
      '–',
      '–',
      'No readings yet',
    ]);
    expect(cells(rows()[5])[2]).toBe('No data in 30 min');
    expect(rows()[5].querySelector('[data-testid=staleness]')!.getAttribute('data-staleness')).toBe(
      'stale-30',
    );
    expect(sortedColumns()).toEqual([['Turbine ▲', 'ascending']]);
    expect(app.text(app.root().querySelector('[data-testid=turbine-count]'))).toBe(
      '7 of 7 turbines',
    );
  });

  it('links each turbine to its page and each farm to its farm page', () => {
    const links = [...rows()[1].querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/farms/FARM02/turbines/TURB002', '/farms/FARM02']);
  });

  it('sorts by a column from its header button, and reverses on a second click', async () => {
    await sortBy('power');
    expect(sortedColumns()).toEqual([['Power (kW) ▲', 'ascending']]);
    // No reading (TURB004) always goes last.
    expect(ids()).toEqual([
      'TURB005',
      'TURB006',
      'TURB007',
      'TURB003',
      'TURB001',
      'TURB002',
      'TURB004',
    ]);

    await sortBy('power');
    expect(sortedColumns()).toEqual([['Power (kW) ▼', 'descending']]);
    expect(ids()).toEqual([
      'TURB002',
      'TURB001',
      'TURB003',
      'TURB007',
      'TURB006',
      'TURB005',
      'TURB004',
    ]);
  });

  it('sorts by status from reporting to never reported, ties by turbine id', async () => {
    await sortBy('status');
    expect(ids()).toEqual([
      'TURB001',
      'TURB002',
      'TURB003',
      'TURB006',
      'TURB005',
      'TURB007',
      'TURB004',
    ]);
  });

  it('sorts by farm, gearbox temperature and last reading time', async () => {
    await sortBy('farm');
    expect(ids()).toEqual([
      'TURB002',
      'TURB004',
      'TURB006',
      'TURB007',
      'TURB001',
      'TURB003',
      'TURB005',
    ]);
    await sortBy('gearbox');
    await sortBy('gearbox');
    expect(ids().slice(0, 2)).toEqual(['TURB006', 'TURB003']);
    await sortBy('time');
    expect(ids()).toEqual([
      'TURB007',
      'TURB005',
      'TURB006',
      'TURB003',
      'TURB001',
      'TURB002',
      'TURB004',
    ]);
  });

  it('filters by turbine id, farm id or farm name, case-insensitively', async () => {
    await filter('farm02');
    expect(ids()).toEqual(['TURB002', 'TURB004', 'TURB006', 'TURB007']);
    expect(app.text(app.root().querySelector('[data-testid=turbine-count]'))).toBe(
      '4 of 7 turbines',
    );
    await filter('prairie');
    expect(ids()).toEqual(['TURB001', 'TURB003', 'TURB005']);
    await filter(' turb003 ');
    expect(ids()).toEqual(['TURB003']);
  });

  it('filters by status, combined with the text filter', async () => {
    await status('stale-60');
    expect(ids()).toEqual(['TURB005', 'TURB007']);
    await filter('FARM01');
    expect(ids()).toEqual(['TURB005']);
    await status('all');
    expect(ids()).toEqual(['TURB001', 'TURB003', 'TURB005']);
  });

  it('lists every status in the filter and keeps the chosen one selected', async () => {
    const select = () =>
      app.root().querySelector<HTMLSelectElement>('[data-testid=status-filter]')!;
    expect([...select().options].map((o) => [o.value, o.textContent?.trim()])).toEqual([
      ['all', 'All statuses'],
      ['ok', 'Reporting'],
      ['stale-15', 'No data in 15 min'],
      ['stale-30', 'No data in 30 min'],
      ['stale-60', 'No data in 60 min'],
      ['empty', 'No readings yet'],
    ]);
    expect(select().value).toBe('all');
    await status('empty');
    expect(select().value).toBe('empty');
  });

  describe('Commissioned column', () => {
    const commissionedCell = (id: string) =>
      app.root().querySelector(`tr[data-turbine-id=${id}] [data-testid=commissioned-cell]`)!;
    async function commissioned(value: string) {
      const select = app
        .root()
        .querySelector<HTMLSelectElement>('[data-testid=commissioned-filter]')!;
      select.value = value;
      select.dispatchEvent(new Event('change'));
      await app.stable();
    }

    it('shows a check mark when commissioned and an X when not, with screen-reader text', () => {
      const icon = (id: string) =>
        commissionedCell(id).querySelector('[data-testid=commissioned-icon]');

      expect(icon('TURB001')!.getAttribute('data-icon')).toBe('check');
      expect(icon('TURB001')!.getAttribute('data-mat-icon-name')).toBe('check');
      expect(icon('TURB001')!.querySelector('svg')).not.toBeNull();
      expect(icon('TURB001')!.getAttribute('aria-hidden')).toBe('true');
      expect(app.text(commissionedCell('TURB001'))).toBe('Commissioned');
      expect(commissionedCell('TURB001').getAttribute('data-commissioned')).toBe('true');

      expect(icon('TURB007')!.getAttribute('data-icon')).toBe('x');
      expect(icon('TURB007')!.getAttribute('data-mat-icon-name')).toBe('close');
      expect(icon('TURB007')!.getAttribute('aria-hidden')).toBe('true');
      expect(app.text(commissionedCell('TURB007'))).toBe('Not commissioned');
      expect(commissionedCell('TURB007').getAttribute('data-commissioned')).toBe('false');
    });

    it('sorts commissioned first, then reversed, ties by turbine id', async () => {
      await sortBy('commissioned');
      expect(sortedColumns()).toEqual([['Commissioned ▲', 'ascending']]);
      expect(ids()).toEqual([
        'TURB001',
        'TURB002',
        'TURB003',
        'TURB005',
        'TURB006',
        'TURB004',
        'TURB007',
      ]);
      await sortBy('commissioned');
      expect(sortedColumns()).toEqual([['Commissioned ▼', 'descending']]);
      expect(ids().slice(0, 2)).toEqual(['TURB004', 'TURB007']);
    });

    it('filters by commissioning, combined with the other filters, keeping the choice selected', async () => {
      const select = () =>
        app.root().querySelector<HTMLSelectElement>('[data-testid=commissioned-filter]')!;
      expect([...select().options].map((o) => [o.value, app.text(o)])).toEqual([
        ['all', 'Any'],
        ['yes', 'Commissioned'],
        ['no', 'Not commissioned'],
      ]);
      expect(select().value).toBe('all');

      await commissioned('no');
      expect(ids()).toEqual(['TURB004', 'TURB007']);
      expect(select().value).toBe('no');
      await status('stale-60');
      expect(ids()).toEqual(['TURB007']);
      await status('all');
      await commissioned('yes');
      expect(ids()).toEqual(['TURB001', 'TURB002', 'TURB003', 'TURB005', 'TURB006']);
      await filter('FARM02');
      expect(ids()).toEqual(['TURB002', 'TURB006']);
      await commissioned('all');
      expect(ids()).toEqual(['TURB002', 'TURB004', 'TURB006', 'TURB007']);
    });
  });

  it('says so when no turbine matches', async () => {
    await filter('nothing');
    expect(rows()).toHaveLength(0);
    expect(app.text(app.root().querySelector('[data-testid=no-matches]'))).toBe(
      'No turbines match the filters.',
    );
  });

  it('updates a row live and re-sorts it', async () => {
    await sortBy('power');
    app.sse.push(
      reading({
        turbineId: 'TURB004',
        farmId: 'FARM02',
        timestamp: '2026-01-03T00:00:00.000Z',
        powerOutputKw: 2500,
        windSpeedMs: 10.2,
        gearboxTempC: 81.5,
      }),
    );
    await app.stable();

    expect(ids().at(-1)).toBe('TURB004');
    const row = rows().at(-1)!;
    expect(cells(row)).toEqual([
      'TURB004',
      'High Plains FARM02',
      'Reporting',
      'Not commissioned',
      'None',
      '2,500',
      '10.2',
      '81.5',
      'Jan 3, 00:00',
    ]);
    expect(row.hasAttribute('data-updated')).toBe(true);
  });

  describe('Alert column', () => {
    let n = 0;
    const rule = (overrides: Partial<AlertConfig>): AlertConfig => ({
      id: `rule-${n++}`,
      measurementMetric: 'gearboxTempC',
      comparison: 'above',
      valueMetric: 120,
      alertLevel: 'error',
      ...overrides,
    });
    /** In metric order, as the API lists them. */
    const RULES = (): AlertConfig[] => [
      rule({
        measurementMetric: 'powerOutputKw',
        comparison: 'below',
        valueMetric: 100,
        alertLevel: 'info',
      }),
      rule({ measurementMetric: 'windSpeedMs', valueMetric: 9, alertLevel: 'warn' }),
      rule({ valueMetric: 90, alertLevel: 'warn' }),
      rule({ valueMetric: 120, alertLevel: 'error' }),
    ];
    const alertCell = (id: string) =>
      table().querySelector(`tr[data-turbine-id=${id}] [data-testid=alert-cell]`)!;
    const alertStates = () =>
      Object.fromEntries(
        rows().map((r) => [
          r.getAttribute('data-turbine-id'),
          r.querySelector('[data-testid=alert-cell]')!.getAttribute('data-alert'),
        ]),
      );
    async function alertFilter(value: string) {
      const select = app.root().querySelector<HTMLSelectElement>('[data-testid=alert-filter]')!;
      select.value = value;
      select.dispatchEvent(new Event('change'));
      await app.stable();
    }
    /** Re-reads the rules as if another browser changed them (alert-config.changed). */
    async function rulesChanged(rules: AlertConfig[]) {
      app.sse.pushEvent('alert-config.changed', { action: 'updated', id: 'x' });
      await app.stable();
      await flushRules(rules);
    }

    /** The Material tooltip of a turbine's alert pill. */
    const tooltip = (id: string) =>
      TestbedHarnessEnvironment.loader(app.harness.fixture).getHarness(
        MatTooltipHarness.with({
          selector: `tr[data-turbine-id=${id}] [data-testid=alert-tooltip-trigger]`,
        }),
      );
    /** The lines of that tooltip (it renders its text only while open). */
    async function details(id: string) {
      const tip = await tooltip(id);
      await tip.show();
      const text = await tip.getTooltipText();
      await tip.hide();
      return text.split('\n');
    }

    it('shows None for every reading when there are no rules, and — without a reading', () => {
      expect(app.text(table().querySelector('thead th:nth-child(5)'))).toBe('Alert');
      expect(alertStates()).toEqual({
        TURB001: 'none',
        TURB002: 'none',
        TURB003: 'none',
        TURB004: 'no-reading',
        TURB005: 'none',
        TURB006: 'none',
        TURB007: 'none',
      });
    });

    it('shows only the worst level pill, with every triggered rule in its tooltip', async () => {
      await rulesChanged(RULES());

      expect(alertStates()).toEqual({
        TURB001: 'none',
        TURB002: 'none',
        TURB003: 'warn',
        TURB004: 'no-reading',
        TURB005: 'warn',
        TURB006: 'error',
        TURB007: 'none',
      });
      // TURB006 (stale, last reading 126.5 °C) is still evaluated.
      const t6 = alertCell('TURB006');
      const pill = t6.querySelector('[data-testid=alert-level]')!;
      expect(pill.getAttribute('data-level')).toBe('error');
      expect(app.text(pill)).toBe('Error');
      // Visibly only the pill: the trigger button holds just the pill, the tooltip is closed.
      const trigger = t6.querySelector<HTMLElement>('[data-testid=alert-tooltip-trigger]')!;
      expect(trigger.contains(pill)).toBe(true);
      expect(app.text(trigger)).toBe('Error');
      expect([trigger.tagName, trigger.getAttribute('type')]).toEqual(['BUTTON', 'button']);
      expect(t6.querySelectorAll('[data-testid=alert-tooltip-trigger]')).toHaveLength(1);
      expect(
        t6.querySelector('details, [data-testid=alert-summary], [data-testid=alert-more]'),
      ).toBeNull();
      const tip = await tooltip('TURB006');
      expect(await tip.isOpen()).toBe(false);
      // Every triggered rule, worst first, with its level: one line each.
      expect(await details('TURB006')).toEqual([
        'Error: Gearbox temperature 126.5 °C > 120',
        'Warning: Gearbox temperature 126.5 °C > 90',
      ]);
      expect(await details('TURB005')).toEqual([
        'Warning: Wind speed 15.8 m/s > 9',
        'Info: Power output 0 kW < 100',
      ]);
      // The message is also the button's accessible description (Material's AriaDescriber).
      const describedBy = trigger.getAttribute('aria-describedby')!;
      expect(document.getElementById(describedBy)?.textContent).toBe(
        'Error: Gearbox temperature 126.5 °C > 120\nWarning: Gearbox temperature 126.5 °C > 90',
      );

      // Hover opens it, leaving closes it; a click/tap opens it too.
      await tip.show();
      expect(await tip.isOpen()).toBe(true);
      expect(document.querySelector('.app-tooltip')).not.toBeNull();
      await tip.hide();
      expect(await tip.isOpen()).toBe(false);
      trigger.click();
      await app.stable();
      expect(await tip.isOpen()).toBe(true);

      // The other states have no tooltip.
      expect(app.text(alertCell('TURB001'))).toBe('None');
      expect(app.text(alertCell('TURB004'))).toBe('—');
      for (const id of ['TURB001', 'TURB004']) {
        expect(alertCell(id).querySelector('[data-testid=alert-tooltip-trigger]')).toBeNull();
      }
    });

    it('sorts by alert (None, Info, Warning, Error; no reading last), ties by turbine id', async () => {
      await rulesChanged(RULES());
      await sortBy('alert');
      expect(sortedColumns()).toEqual([['Alert ▲', 'ascending']]);
      expect(ids()).toEqual([
        'TURB001',
        'TURB002',
        'TURB007',
        'TURB003',
        'TURB005',
        'TURB006',
        'TURB004',
      ]);

      await sortBy('alert');
      expect(sortedColumns()).toEqual([['Alert ▼', 'descending']]);
      expect(ids()).toEqual([
        'TURB006',
        'TURB003',
        'TURB005',
        'TURB001',
        'TURB002',
        'TURB007',
        'TURB004',
      ]);
    });

    it('filters by alert level or none, combined with the other filters', async () => {
      await rulesChanged(RULES());
      const select = () =>
        app.root().querySelector<HTMLSelectElement>('[data-testid=alert-filter]')!;
      expect([...select().options].map((o) => [o.value, app.text(o)])).toEqual([
        ['all', 'Any'],
        ['error', 'Error'],
        ['warn', 'Warning'],
        ['info', 'Info'],
        ['none', 'None'],
      ]);

      await alertFilter('error');
      expect(ids()).toEqual(['TURB006']);
      await alertFilter('warn');
      expect(ids()).toEqual(['TURB003', 'TURB005']);
      expect(select().value).toBe('warn');
      await status('stale-60');
      expect(ids()).toEqual(['TURB005']);
      await status('all');
      await alertFilter('info');
      expect(ids()).toEqual([]);
      await alertFilter('none');
      expect(ids()).toEqual(['TURB001', 'TURB002', 'TURB007']);
      await alertFilter('all');
      expect(ids()).toHaveLength(7);
    });

    it('updates live when a new reading crosses a threshold', async () => {
      await rulesChanged(RULES());
      app.sse.push(reading({ timestamp: '2026-01-03T00:00:00.000Z', gearboxTempC: 121 }));
      await app.stable();

      expect(alertCell('TURB001').getAttribute('data-alert')).toBe('error');
      expect(await details('TURB001')).toEqual([
        'Error: Gearbox temperature 121 °C > 120',
        'Warning: Gearbox temperature 121 °C > 90',
      ]);

      app.sse.push(reading({ timestamp: '2026-01-03T00:05:00.000Z', gearboxTempC: 85 }));
      await app.stable();
      expect(alertCell('TURB001').getAttribute('data-alert')).toBe('none');
    });

    it('re-evaluates when the rules change (alert-config.changed)', async () => {
      await rulesChanged([rule({ valueMetric: 70, alertLevel: 'info' })]);
      expect(alertCell('TURB001').getAttribute('data-alert')).toBe('info');

      await rulesChanged([]);
      expect(alertCell('TURB001').getAttribute('data-alert')).toBe('none');
    });
  });
});

describe('TurbineList when the alert rules cannot be loaded', () => {
  it('shows — with an accessible hint, and the rest of the table still works', async () => {
    const app = await openFleet(
      '/turbines',
      () => Date.parse('2026-01-03T00:00:00.000Z'),
      mixedFleetFixture(),
    );
    app.http.expectOne(RULES_URL).flush('down', { status: 503, statusText: 'Unavailable' });
    await app.stable();

    expect(app.text(app.root().querySelector('[data-testid=alert-rules-unavailable]'))).toBe(
      'Alert rules could not be loaded, so the Alert column is unavailable.',
    );
    const row = app.root().querySelector('tr[data-turbine-id=TURB006]')!;
    const cell = row.querySelector('[data-testid=alert-cell]')!;
    expect(cell.getAttribute('data-alert')).toBe('unavailable');
    expect(app.text(cell.querySelector('[aria-hidden=true]'))).toBe('—');
    expect(app.text(cell.querySelector('.sr-only'))).toBe('Alert rules unavailable');
    expect(cell.querySelector('[role=tooltip]')).toBeNull();
    expect(app.text(row.querySelectorAll('td')[5])).toBe('300'); // power still shown
    expect(app.text(app.root().querySelector('[data-testid=turbine-count]'))).toBe(
      '7 of 7 turbines',
    );

    // A later alert-config.changed retries; success clears the hint.
    app.sse.pushEvent('alert-config.changed', { action: 'created', id: 'x' });
    await app.stable();
    app.http.expectOne(RULES_URL).flush([]);
    await app.stable();
    expect(app.root().querySelector('[data-testid=alert-rules-unavailable]')).toBeNull();
    expect(cell.getAttribute('data-alert')).toBe('none');
    app.http.verify();
  });
});

describe('TurbineList without turbines', () => {
  it('shows an empty state', async () => {
    const app = await openFleet('/turbines', () => Date.parse('2026-01-03T00:00:00.000Z'), [
      { id: 'FARM03', name: 'Red Canyon', latitude: 35.12, longitude: -106.55, turbines: [] },
    ]);
    expect(app.root().querySelector('[data-testid=turbines]')).toBeNull();
    expect(app.text(app.root().querySelector('[data-testid=no-turbines]'))).toBe(
      'No turbines are registered yet.',
    );
  });
});
