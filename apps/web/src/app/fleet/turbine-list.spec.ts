import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { MatPaginatorHarness } from '@angular/material/paginator/testing';
import {
  TEST_API_BASE_URL,
  largeFleetFixture,
  mixedFleetFixture,
  openFleet,
  reading,
} from './testing';

const RULES_URL = `${TEST_API_BASE_URL}/alert-configs`;

/** /turbines through the real routes, with the mixed fleet at 2026-01-03T00:00Z. */
describe('TurbineList (/turbines)', () => {
  const CLOCK = Date.parse('2026-01-03T00:00:00.000Z');
  let app: Awaited<ReturnType<typeof openFleet>>;
  beforeEach(async () => {
    app = await openFleet('/turbines', () => CLOCK, mixedFleetFixture());
  });
  afterEach(() => app.http.verify());

  const table = () => app.root().querySelector('[data-testid=turbines]')!;
  const rows = () => [...table().querySelectorAll('tbody tr[data-turbine-id]')];
  const ids = () => rows().map((r) => r.getAttribute('data-turbine-id'));
  const cells = (row: Element) => [...row.querySelectorAll('td')].map((td) => app.text(td));
  const sortButton = (key: string) =>
    app.root().querySelector<HTMLElement>(`[data-testid=sort-${key}]`)!;
  /** The sorted header (MatSort marks the others aria-sort="none"). */
  const sortedColumns = () =>
    [...table().querySelectorAll('th[aria-sort]:not([aria-sort=none])')].map((th) => [
      app.text(th),
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

  it('labels each filter with a Material outline field', () => {
    const label = (testId: string) => {
      const control = app.root().querySelector(`[data-testid=${testId}]`)!;
      expect(control.closest('mat-form-field')!.classList).toContain(
        'mat-form-field-appearance-outline',
      );
      return app.text(app.root().querySelector(`label[for="${control.id}"]`));
    };
    expect(['turbine-filter', 'status-filter', 'commissioned-filter'].map(label)).toEqual([
      'Turbine or farm',
      'Status',
      'Commissioned',
    ]);
    // The selects stay native, so they keep the platform pickers (and the tests' change events).
    expect(app.root().querySelector('[data-testid=status-filter]')!.tagName).toBe('SELECT');
  });

  it('clears the turbine and farm search with the clear button in the field', async () => {
    const input = () => app.root().querySelector<HTMLInputElement>('[data-testid=turbine-filter]')!;
    const clear = () =>
      app.root().querySelector<HTMLButtonElement>('[data-testid=turbine-filter-clear]');
    // Only while there is something to clear.
    expect(clear()).toBeNull();

    await filter('farm01');
    expect(ids()).toEqual(['TURB001', 'TURB003', 'TURB005']);
    const button = clear()!;
    expect([button.type, button.getAttribute('aria-label')]).toEqual(['button', 'Clear search']);
    expect(button.hasAttribute('matsuffix')).toBe(true);
    expect(button.closest('.mat-mdc-form-field-icon-suffix')).not.toBeNull();
    expect(button.querySelector('mat-icon')!.getAttribute('data-mat-icon-name')).toBe('close');

    button.click();
    await app.stable();
    expect(input().value).toBe('');
    expect(ids()).toHaveLength(7);
    expect(app.text(app.root().querySelector('[data-testid=turbine-count]'))).toBe(
      '7 of 7 turbines',
    );
    expect(document.activeElement).toBe(input());
    expect(clear()).toBeNull();
  });

  it('fits filters and table in the window: only the rows scroll, under a sticky header, above the paginator', () => {
    // The page is a flex column filling the shell's window-high main area.
    const host = app.root().querySelector('app-turbine-list')!;
    expect([...host.classList]).toEqual(expect.arrayContaining(['flex', 'flex-1', 'min-h-0']));
    const frame = app.root().querySelector('[data-testid=turbines-frame]')!;
    expect([...frame.classList]).toEqual(
      expect.arrayContaining(['flex', 'flex-col', 'min-h-48', 'overflow-hidden']),
    );
    expect(frame.previousElementSibling!.getAttribute('role')).toBe('search');

    const region = app.root().querySelector<HTMLElement>('[data-testid=turbines-scroll]')!;
    expect([region.getAttribute('role'), region.getAttribute('aria-label')]).toEqual([
      'region',
      'Turbines',
    ]);
    expect(region.tabIndex).toBe(0); // keyboard users can scroll it
    expect([...region.classList]).toEqual(expect.arrayContaining(['overflow-auto', 'min-h-0']));
    expect(region.contains(table())).toBe(true);
    const paginator = app.root().querySelector('[data-testid=turbines-paginator]')!;
    expect(region.contains(paginator)).toBe(false);
    expect(paginator.parentElement).toBe(frame);
    for (const th of table().querySelectorAll('thead th')) {
      expect(th.classList).toContain('mat-mdc-table-sticky');
    }
  });

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
      '–',
      '–',
      '–',
      'No readings yet',
    ]);
    expect(cells(rows()[5])[2]).toBe('No data in 30 min');
    expect(rows()[5].querySelector('[data-testid=staleness]')!.getAttribute('data-staleness')).toBe(
      'stale-30',
    );
    expect(sortedColumns()).toEqual([['Turbine', 'ascending']]);
    expect(app.text(app.root().querySelector('[data-testid=turbine-count]'))).toBe(
      '7 of 7 turbines',
    );
  });

  it('has no Alert column, filter or sort, and does not load the alert rules', () => {
    expect([...table().querySelectorAll('thead th')].map((th) => app.text(th))).toEqual([
      'Turbine',
      'Farm',
      'Status',
      'Commissioned',
      'Power (kW)',
      'Wind (m/s)',
      'Gearbox (°C)',
      'Last reading (UTC)',
    ]);
    expect(
      app
        .root()
        .querySelector(
          '[data-testid=alert-cell], [data-testid=alert-filter], [data-testid=sort-alert]',
        ),
    ).toBeNull();
    app.http.expectNone(RULES_URL);
  });

  it('links each turbine to its page and each farm to its farm page', () => {
    const links = [...rows()[1].querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(links).toEqual(['/farms/FARM02/turbines/TURB002', '/farms/FARM02']);
  });

  it('sorts by a column from its header button, and reverses on a second click', async () => {
    // Every header is a Material sort header: a focusable role=button, aria-sort on the <th>.
    const headers = [...table().querySelectorAll('thead th')];
    expect(headers).toHaveLength(8);
    for (const th of headers) {
      expect(th.classList).toContain('mat-sort-header');
      const button = th.querySelector('[role=button]')!;
      expect(button.getAttribute('tabindex')).toBe('0');
    }
    await sortBy('power');
    expect(sortedColumns()).toEqual([['Power (kW)', 'ascending']]);
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
    expect(sortedColumns()).toEqual([['Power (kW)', 'descending']]);
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
      expect(sortedColumns()).toEqual([['Commissioned', 'ascending']]);
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
      expect(sortedColumns()).toEqual([['Commissioned', 'descending']]);
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
      '2,500',
      '10.2',
      '81.5',
      'Jan 3, 00:00',
    ]);
    expect(row.hasAttribute('data-updated')).toBe(true);
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

/** /turbines with more turbines than fit on a page. */
describe('TurbineList pagination', () => {
  const CLOCK = Date.parse('2026-01-03T00:00:00.000Z');
  let app: Awaited<ReturnType<typeof openFleet>>;
  beforeEach(async () => {
    app = await openFleet('/turbines', () => CLOCK, largeFleetFixture(30));
  });
  afterEach(() => app.http.verify());

  const ids = () =>
    [...app.root().querySelectorAll('[data-testid=turbines] tbody tr[data-turbine-id]')].map((r) =>
      r.getAttribute('data-turbine-id'),
    );
  const paginator = () =>
    TestbedHarnessEnvironment.loader(app.harness.fixture).getHarness(
      MatPaginatorHarness.with({ selector: '[data-testid=turbines-paginator]' }),
    );

  it('shows 25 turbines per page with a Material paginator, and pages through the rest', async () => {
    const pages = await paginator();
    expect(ids()).toHaveLength(25);
    expect([ids()[0], ids()[24]]).toEqual(['TURB001', 'TURB025']);
    expect(await pages.getRangeLabel()).toBe('1 – 25 of 30');
    expect(await pages.isPreviousPageDisabled()).toBe(true);
    // The count above the table is every match, not the page.
    expect(app.text(app.root().querySelector('[data-testid=turbine-count]'))).toBe(
      '30 of 30 turbines',
    );

    await pages.goToNextPage();
    expect(ids()).toEqual(['TURB026', 'TURB027', 'TURB028', 'TURB029', 'TURB030']);
    expect(await pages.getRangeLabel()).toBe('26 – 30 of 30');
    expect(await pages.isNextPageDisabled()).toBe(true);

    await pages.setPageSize(10);
    expect(await pages.getPageSize()).toBe(10);
    expect(ids()).toHaveLength(10);
  });

  it('pages the sorted, filtered rows and goes back to the first page on a sort or filter', async () => {
    const pages = await paginator();
    await pages.goToNextPage();

    // Sorting by power descending: the first page holds the 25 highest.
    const power = app.root().querySelector<HTMLElement>('[data-testid=sort-power]')!;
    power.click();
    power.click();
    await app.stable();
    expect(await pages.getRangeLabel()).toBe('1 – 25 of 30');
    expect([ids()[0], ids()[24]]).toEqual(['TURB030', 'TURB006']);

    await pages.goToNextPage();
    const input = app.root().querySelector<HTMLInputElement>('[data-testid=turbine-filter]')!;
    input.value = 'TURB01';
    input.dispatchEvent(new Event('input'));
    await app.stable();
    expect(await pages.getRangeLabel()).toBe('1 – 10 of 10');
    expect(ids()).toHaveLength(10);
  });
});
