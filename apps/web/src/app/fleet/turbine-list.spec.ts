import { mixedFleetFixture, openFleet, reading } from './testing';

/** /turbines through the real routes, with the mixed fleet at 2026-01-03T00:00Z. */
describe('TurbineList (/turbines)', () => {
  const CLOCK = Date.parse('2026-01-03T00:00:00.000Z');
  let app: Awaited<ReturnType<typeof openFleet>>;
  beforeEach(async () => (app = await openFleet('/turbines', () => CLOCK, mixedFleetFixture())));

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
      '1,961',
      '6.7',
      '80.0',
      'Jan 2, 23:55',
    ]);
    expect(cells(rows()[3])).toEqual([
      'TURB004',
      'High Plains FARM02',
      'No readings yet',
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
