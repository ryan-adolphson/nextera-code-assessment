import type { Mock } from 'vitest';
import { Router } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { RowGlide } from '../ui/row-glide';
import { FLASH_MS } from './fleet.store';
import { largeFleetFixture, mixedFleetFixture, openFleet, reading } from './testing';
import { LIVE_BATCH_MS } from './turbine-page.store';

/**
 * The turbines table during live updates (the mixed fleet at 2026-01-03T00:00Z, newest first): the
 * page's readings are applied in one update a second (cells, flash and, when the sort is by a value
 * readings change, the order); readings for turbines not on the page are dropped. The page opens
 * on real timers, then time only moves in `wait()` (so the 1 s boundary is exact) and change
 * detection runs by `TestBed.tick()`: `whenStable()` and harnesses would wait on a faked timer.
 */
describe('TurbineTable live updates', () => {
  const CLOCK = Date.parse('2026-01-03T00:00:00.000Z');
  const AT_CLOCK = '2026-01-03T00:00:00.000Z';
  let app: Awaited<ReturnType<typeof openFleet>>;
  let reorder: Mock<RowGlide['reorder']>;

  async function open(url: string, fleet = mixedFleetFixture()) {
    app = await openFleet(url, () => CLOCK, fleet);
    await app.stable();
    vi.useFakeTimers();
    TestBed.tick();
  }
  beforeEach(() => {
    reorder = vi.spyOn(RowGlide.prototype, 'reorder');
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const table = () => app.root().querySelector('[data-testid=turbines]')!;
  const rows = () => [...table().querySelectorAll('tbody tr[data-turbine-id]')];
  const ids = () => rows().map((r) => r.getAttribute('data-turbine-id')!);
  const row = (id: string) => rows().find((r) => r.getAttribute('data-turbine-id') === id)!;
  const flashing = () => ids().filter((id) => row(id).hasAttribute('data-updated'));
  const cells = (id: string) => [...row(id).querySelectorAll('td')].map((td) => app.text(td));
  async function push(turbineId: string, farmId: string, powerOutputKw = 1234) {
    app.sse.push(reading({ turbineId, farmId, timestamp: AT_CLOCK, powerOutputKw }));
    TestBed.tick();
  }
  async function wait(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
    TestBed.tick();
  }
  async function clickSort(key: string) {
    app.root().querySelector<HTMLElement>(`[data-testid=sort-${key}]`)!.click();
    await flush();
  }
  /** Runs the change detection and the microtasks a request and its answer need. */
  async function flush() {
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();
  }
  const button = (label: string) =>
    app.root().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const range = () => app.text(app.root().querySelector('.mat-mdc-paginator-range-label'));

  it('applies the readings once a second, not at once', async () => {
    await open('/turbines');

    await push('TURB007', 'FARM02', 2345);
    expect(cells('TURB007')).not.toContain('2,345');
    expect(flashing()).toEqual([]);

    await wait(LIVE_BATCH_MS - 1);
    expect(cells('TURB007')).not.toContain('2,345');

    await wait(1);
    expect(cells('TURB007')).toContain('2,345');
    expect(cells('TURB007')).toContain('Reporting');
    expect(flashing()).toEqual(['TURB007']);
  });

  it('puts a burst in one update and flashes each updated row for 2 s', async () => {
    await open('/turbines');

    await push('TURB006', 'FARM02');
    await wait(300);
    await push('TURB007', 'FARM02');
    await wait(LIVE_BATCH_MS - 300);
    expect(flashing().sort()).toEqual(['TURB006', 'TURB007']);
    expect(reorder).toHaveBeenCalledOnce();

    await wait(FLASH_MS - 1);
    expect(flashing().sort()).toEqual(['TURB006', 'TURB007']);
    await wait(1);
    expect(flashing()).toEqual([]);
  });

  it('keeps the newest reading per turbine when several arrive in a batch', async () => {
    await open('/turbines');

    await push('TURB007', 'FARM02', 3000);
    app.sse.push(
      reading({
        turbineId: 'TURB007',
        farmId: 'FARM02',
        timestamp: '2026-01-02T23:58:00.000Z',
        powerOutputKw: 111,
      }),
    ); // older than the first: dropped
    TestBed.tick();
    await wait(LIVE_BATCH_MS);

    expect(cells('TURB007')).toContain('3,000');
    expect(cells('TURB007')).not.toContain('111');
  });

  it('re-orders the page by last reading with a glide when sorted by it', async () => {
    await open('/turbines');
    expect(ids().indexOf('TURB007')).toBeGreaterThan(0);

    await push('TURB007', 'FARM02');
    await wait(LIVE_BATCH_MS);

    expect(ids().slice(0, 3)).toEqual(['TURB007', 'TURB001', 'TURB002']); // newest now
    expect(reorder).toHaveBeenCalledOnce();
  });

  it('leaves the order alone under a sort live readings do not change, and does not glide', async () => {
    await open('/turbines');
    await clickSort('id');
    const before = ids();

    await push('TURB007', 'FARM02', 2345);
    await wait(LIVE_BATCH_MS);

    expect(cells('TURB007')).toContain('2,345');
    expect(ids()).toEqual(before);
    expect(reorder).not.toHaveBeenCalled();
  });

  it("re-orders a farm's page by power when it is sorted by power", async () => {
    await open('/farms/FARM02');
    await clickSort('power');
    await clickSort('power'); // highest first
    expect(ids()).toEqual(['TURB002', 'TURB007', 'TURB006']);

    await push('TURB006', 'FARM02', 5000);
    await wait(LIVE_BATCH_MS);

    expect(ids()).toEqual(['TURB006', 'TURB002', 'TURB007']);
  });

  it('drops readings of turbines that are not on the page', async () => {
    await open('/farms/FARM02');

    await push('TURB001', 'FARM01'); // another farm
    await push('TURB999', 'FARM02'); // unknown
    await wait(LIVE_BATCH_MS);

    expect(flashing()).toEqual([]);
    expect(reorder).not.toHaveBeenCalled();
    expect(app.root().querySelector('[data-turbine-id=TURB001]')).toBeNull();
  });

  it('ignores a reading that is not newer than the row', async () => {
    await open('/turbines');

    app.sse.push(
      reading({
        turbineId: 'TURB001',
        farmId: 'FARM01',
        timestamp: '2026-01-02T23:55:00.000Z', // the row's own time
        powerOutputKw: 4321,
      }),
    );
    TestBed.tick();
    await wait(LIVE_BATCH_MS);

    expect(cells('TURB001')).not.toContain('4,321');
    expect(flashing()).toEqual([]);
  });

  it('shows a never-reported turbine only when the page is fetched again', async () => {
    const fleet = mixedFleetFixture();
    await open('/turbines', fleet);
    expect(ids()).not.toContain('TURB004'); // hidden: no data yet
    const requests = app.api.turbines.mock.calls.length;

    const first = reading({ turbineId: 'TURB004', farmId: 'FARM02', timestamp: AT_CLOCK });
    await push('TURB004', 'FARM02');
    await wait(LIVE_BATCH_MS);
    expect(ids()).not.toContain('TURB004'); // not on the page: dropped

    fleet[1].turbines[1].latest = first;
    app.sse.status('open'); // the stream (re)opened: the page is fetched again
    await flush();

    expect(app.api.turbines.mock.calls.length).toBe(requests + 1);
    expect(ids()).toContain('TURB004');
  });

  it('moves between pages with next and previous, never repeating or losing a row', async () => {
    await open('/turbines', largeFleetFixture(60)); // all equally new: by id
    expect(ids()).toHaveLength(25);
    expect(range()).toBe('1 – 25 of 60');
    expect(button('Previous page').getAttribute('aria-disabled')).toBe('true');

    button('Next page').click();
    await flush();
    expect(range()).toBe('26 – 50 of 60');
    const second = ids();
    button('Next page').click();
    await flush();
    expect(range()).toBe('51 – 60 of 60');
    expect(button('Next page').getAttribute('aria-disabled')).toBe('true');
    const third = ids();
    expect(new Set([...second, ...third]).size).toBe(35);

    button('Previous page').click();
    await flush();
    expect(ids()).toEqual(second);
  });

  it('drops a reading for a turbine on another page', async () => {
    await open('/turbines', largeFleetFixture(60));
    await push('TURB060', 'FARM01', 7777); // page 3, not shown
    await wait(LIVE_BATCH_MS);
    expect(flashing()).toEqual([]);
  });

  it('shows the other farm at once when the farm changes, without a glide', async () => {
    await open('/farms/FARM02');
    await push('TURB007', 'FARM02');

    await TestBed.inject(Router).navigateByUrl('/farms/FARM01');
    await flush();

    const expected = mixedFleetFixture()
      .find((f) => f.id === 'FARM01')!
      .turbines.map((t) => t.id);
    expect(ids().sort()).toEqual(expected.sort());
    await wait(LIVE_BATCH_MS);
    expect(reorder).not.toHaveBeenCalled();
  });

  it('clears its batch timer when destroyed', async () => {
    await open('/turbines');
    await push('TURB007', 'FARM02');

    await TestBed.inject(Router).navigateByUrl('/settings');
    TestBed.tick();

    await wait(LIVE_BATCH_MS);
    expect(reorder).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1); // the store's minute clock
  });
});
