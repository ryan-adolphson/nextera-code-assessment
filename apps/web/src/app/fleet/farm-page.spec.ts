import { TestBed } from '@angular/core/testing';
import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { MatPaginatorHarness } from '@angular/material/paginator/testing';
import { MatSlideToggleHarness } from '@angular/material/slide-toggle/testing';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { TurbineMarkerResponse } from './fleet.model';
import { FILTER_DEBOUNCE_MS, LIVE_BATCH_MS } from './turbine-page.store';
import { largeFleetFixture, mixedFleetFixture, openFleet, reading } from './testing';

/**
 * The farm page's turbines table (the shared /turbines table, scoped to the farm, no Farm column):
 * /farms/FARM02 of the mixed fleet at 2026-01-03T00:00Z. FARM02 has TURB002 (reporting), TURB004
 * (never reported, not commissioned), TURB006 (40 min: stale-30) and TURB007 (2 h 30 min:
 * stale-60, not commissioned).
 */
describe('FarmPage turbines table (/farms/:farmId)', () => {
  const CLOCK = Date.parse('2026-01-03T00:00:00.000Z');
  let app: Awaited<ReturnType<typeof openFleet>>;
  beforeEach(async () => {
    // Viewers see the Commissioned check mark or X (owners get a switch: turbine-table-commissioned.spec).
    app = await openFleet('/farms/FARM02', () => CLOCK, mixedFleetFixture(), undefined, 'viewer');
    await app.stable(); // the deferred map renders
    // The typed filter waits FILTER_DEBOUNCE_MS: faked, but following real time for the harnesses.
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
    app.http.verify(); // no other requests (e.g. no alert rules)
  });

  const q = <T extends Element = HTMLElement>(testId: string) =>
    app.root().querySelector<T>(`[data-testid=${testId}]`)!;
  const table = () => q('turbines');
  const rows = () => [...table().querySelectorAll('tbody tr[data-turbine-id]')];
  const ids = () => rows().map((r) => r.getAttribute('data-turbine-id'));
  const cells = (row: Element) => [...row.querySelectorAll('td')].map((td) => app.text(td));
  const count = () => app.text(q('turbine-count'));
  const sortedColumns = () =>
    [...table().querySelectorAll('th[aria-sort]:not([aria-sort=none])')].map((th) => [
      app.text(th),
      th.getAttribute('aria-sort'),
    ]);
  async function sortBy(key: string) {
    q(`sort-${key}`).click();
    await app.stable();
  }
  async function filter(value: string) {
    const input = q<HTMLInputElement>('turbine-filter');
    input.value = value;
    input.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(FILTER_DEBOUNCE_MS);
    await app.stable();
  }
  async function choose(testId: string, value: string) {
    const select = q<HTMLSelectElement>(testId);
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await app.stable();
  }

  /** Turns "Hide turbines with no data" off, so TURB004 (never reported) is listed. */
  async function showNoData() {
    const toggle = await TestbedHarnessEnvironment.loader(app.harness.fixture).getHarness(
      MatSlideToggleHarness.with({ selector: '[data-testid=hide-no-data]' }),
    );
    await toggle.uncheck();
    await app.stable();
  }

  it("lists only this farm's turbines, newest first, with the /turbines columns except Farm", async () => {
    expect(app.text(app.root().querySelector('h1'))).toBe('High Plains FARM02');
    expect(ids()).toEqual(['TURB002', 'TURB006', 'TURB007']);
    expect(count()).toBe('3 of 3 turbines');
    expect([...table().querySelectorAll('thead th')].map((th) => app.text(th))).toEqual([
      'Turbine',
      'Status',
      'Commissioned',
      'Power (kW)',
      'Wind (m/s)',
      'Gearbox (°C)',
      'Last reading (UTC)',
    ]);
    expect(app.root().querySelector('[data-testid=sort-farm]')).toBeNull();
    expect(cells(rows()[0])).toEqual([
      'TURB002',
      'Reporting',
      'Commissioned',
      '2,259',
      '8.5',
      '80.0',
      'Jan 2, 23:55',
    ]);
    expect(sortedColumns()).toEqual([['Last reading (UTC)', 'descending']]);
    // The map shows every turbine, the hidden one too, and stays above the table.
    expect(app.root().querySelectorAll('.map-marker')).toHaveLength(4);

    // Never reported: no values, and not commissioned (X); last.
    await showNoData();
    expect(count()).toBe('4 of 4 turbines');
    expect(app.api.turbines).toHaveBeenLastCalledWith(
      expect.objectContaining({ farmId: 'FARM02' }),
    );
    expect(cells(rows()[3])).toEqual([
      'TURB004',
      'No readings yet',
      'Not commissioned',
      '–',
      '–',
      '–',
      'No readings yet',
    ]);
    expect(
      rows().map((r) =>
        r.querySelector('[data-testid=commissioned-icon]')!.getAttribute('data-icon'),
      ),
    ).toEqual(['check', 'check', 'x', 'x']);
    expect(
      rows().map((r) => r.querySelector('[data-testid=staleness]')!.getAttribute('data-staleness')),
    ).toEqual(['ok', 'stale-30', 'stale-60', 'empty']);
    // Each turbine id opens its page under this farm.
    expect(rows().map((r) => r.querySelector('a')!.getAttribute('href'))).toEqual([
      '/farms/FARM02/turbines/TURB002',
      '/farms/FARM02/turbines/TURB006',
      '/farms/FARM02/turbines/TURB007',
      '/farms/FARM02/turbines/TURB004',
    ]);
  });

  it('sorts by any column but status, reverses on a second click, and keeps turbines without readings last', async () => {
    await showNoData();
    expect(q('metric-sort-hint')).toBeNull(); // a farm: the metrics can be sorted
    await sortBy('power');
    expect(ids()).toEqual(['TURB006', 'TURB007', 'TURB002', 'TURB004']); // 300, 1000, 2259, none
    expect(sortedColumns()).toEqual([['Power (kW)', 'ascending']]);
    expect(app.api.turbines).toHaveBeenLastCalledWith(
      expect.objectContaining({ farmId: 'FARM02', sort: 'power', dir: 'asc' }),
    );

    await sortBy('power');
    expect(ids()).toEqual(['TURB002', 'TURB007', 'TURB006', 'TURB004']); // still last
    expect(sortedColumns()).toEqual([['Power (kW)', 'descending']]);

    await sortBy('wind');
    expect(ids()).toEqual(['TURB006', 'TURB007', 'TURB002', 'TURB004']); // 4, 5, 8.5
    await sortBy('gearbox');
    expect(ids().at(-1)).toBe('TURB004');

    await sortBy('commissioned'); // commissioned first, ties by id
    expect(ids()).toEqual(['TURB002', 'TURB006', 'TURB004', 'TURB007']);

    expect(q('sort-status').classList).not.toContain('mat-sort-header'); // the API has no status sort
  });

  it('filters by turbine id, status and commissioning, on the server', async () => {
    const input = q<HTMLInputElement>('turbine-filter');
    expect(app.text(app.root().querySelector(`label[for="${input.id}"]`))).toBe('Turbine');
    expect(input.placeholder).toBe('e.g. TURB001');

    await filter('turb006');
    expect(app.api.turbines).toHaveBeenLastCalledWith(
      expect.objectContaining({ farmId: 'FARM02', q: 'turb006' }),
    );
    expect(ids()).toEqual(['TURB006']);
    expect(count()).toBe('1 of 1 turbines');

    await filter('nothing');
    expect(ids()).toEqual([]);
    const empty = q('no-matches');
    expect(app.text(empty)).toContain('No turbines match the filters.');
    expect(empty.getAttribute('colspan')).toBe('7');
    expect(count()).toBe('0 of 0 turbines');

    await filter('');
    await choose('status-filter', 'stale');
    expect(ids()).toEqual(['TURB006', 'TURB007']);

    await choose('status-filter', 'all');
    await choose('commissioned-filter', 'no');
    expect(ids()).toEqual(['TURB007']);
    expect(count()).toBe('1 of 1 turbines');
  });

  it("shows the farm's data time and says the figures refresh about once a minute", () => {
    expect(app.text(q('farm-as-of'))).toBe('Jan 2, 23:55 UTC');
    expect(app.text(q('farm-refresh-note'))).toBe(
      'Farm figures refresh about once a minute. The turbines below update live.',
    );
  });

  it("shows no markers of the previous farm while the next farm's markers load", async () => {
    expect(app.root().querySelectorAll('.map-marker')).toHaveLength(4);
    const next = new Subject<TurbineMarkerResponse[]>();
    app.api.turbineMarkers.mockReturnValue(next);

    await TestBed.inject(Router).navigateByUrl('/farms/FARM01');
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();

    expect(app.api.turbineMarkers).toHaveBeenLastCalledWith('FARM01');
    expect(app.root().querySelectorAll('.map-marker')).toHaveLength(0);

    next.next([
      {
        id: 'TURB001',
        latitude: 41.2,
        longitude: -96.5,
        status: 'reporting',
        timestamp: '2026-01-02T23:55:00.000Z',
      },
    ]);
    next.complete();
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();
    await app.stable();
    expect(app.root().querySelectorAll('.map-marker')).toHaveLength(1);
  });

  it("updates a row live and ignores other farms' readings", async () => {
    app.sse.push(
      reading({
        turbineId: 'TURB006',
        farmId: 'FARM02',
        timestamp: '2026-01-03T00:00:00.000Z',
        powerOutputKw: 1800,
      }),
    );
    await vi.advanceTimersByTimeAsync(LIVE_BATCH_MS);
    await app.stable();
    const row = rows().find((r) => r.getAttribute('data-turbine-id') === 'TURB006')!;
    expect(cells(row)).toEqual([
      'TURB006',
      'Reporting',
      'Commissioned',
      '1,800',
      '7.0',
      '80.0',
      'Jan 3, 00:00',
    ]);
    expect(row.hasAttribute('data-updated')).toBe(true);

    app.sse.push(
      reading({ turbineId: 'TURB001', farmId: 'FARM01', timestamp: '2026-01-03T00:00:00.000Z' }),
    );
    await vi.advanceTimersByTimeAsync(LIVE_BATCH_MS);
    await app.stable();
    expect(ids()).toEqual(['TURB006', 'TURB002', 'TURB007']); // TURB006 is now the newest, and TURB001 is not on this page
  });
});

describe('FarmPage turbines table pagination', () => {
  it('shows 25 turbines per page with the Material paginator', async () => {
    const app = await openFleet(
      '/farms/FARM01',
      () => Date.parse('2026-01-03T00:00:00.000Z'),
      largeFleetFixture(30),
    );
    const ids = () =>
      [...app.root().querySelectorAll('[data-testid=turbines] tbody tr[data-turbine-id]')].map(
        (r) => r.getAttribute('data-turbine-id'),
      );
    const pages = await TestbedHarnessEnvironment.loader(app.harness.fixture).getHarness(
      MatPaginatorHarness.with({ selector: '[data-testid=turbines-paginator]' }),
    );
    expect(ids()).toHaveLength(25);
    expect(await pages.getRangeLabel()).toBe('1 – 25 of 30');
    expect(app.text(app.root().querySelector('[data-testid=turbine-count]'))).toBe(
      '25 of 30 turbines',
    );

    await pages.goToNextPage();
    expect(ids()).toEqual(['TURB026', 'TURB027', 'TURB028', 'TURB029', 'TURB030']);
    app.http.verify();
  });
});
