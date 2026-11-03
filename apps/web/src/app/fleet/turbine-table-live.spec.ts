import type { Mock } from 'vitest';
import { Router } from '@angular/router';
import { TestBed } from '@angular/core/testing';
import { RowGlide } from '../ui/row-glide';
import { FLASH_MS } from './fleet.store';
import { largeFleetFixture, mixedFleetFixture, openFleet, reading } from './testing';
import { ORDER_MAX_HOLD_MS, ORDER_QUIET_MS } from './turbine-table';

/**
 * The turbines table during live bursts (the mixed fleet at 2026-01-03T00:00Z, newest first): the
 * cells and the flash follow every reading, the order follows once per burst. The page opens on
 * real timers, then time only moves in `wait()` (so the 1 s and 3 s boundaries are exact) and change
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
  function clickSort(key: string) {
    app.root().querySelector<HTMLElement>(`[data-testid=sort-${key}]`)!.click();
    TestBed.tick();
  }
  async function type(value: string) {
    const input = app.root().querySelector<HTMLInputElement>('[data-testid=turbine-filter]')!;
    input.value = value;
    input.dispatchEvent(new Event('input'));
    TestBed.tick();
  }

  it('keeps the rows of a burst flashing together for the whole 2 s, across the re-order', async () => {
    await open('/turbines');

    await push('TURB006', 'FARM02');
    await wait(300);
    await push('TURB007', 'FARM02');
    expect(flashing().sort()).toEqual(['TURB006', 'TURB007']);

    await wait(ORDER_QUIET_MS); // the order settles at 1.3 s; both are still flashing
    expect(reorder).toHaveBeenCalledOnce();
    expect(flashing().sort()).toEqual(['TURB006', 'TURB007']);

    await wait(FLASH_MS - ORDER_QUIET_MS - 300 - 1);
    expect(flashing().sort()).toEqual(['TURB006', 'TURB007']);
    await wait(1);
    expect(flashing()).toEqual(['TURB007']);
    await wait(300);
    expect(flashing()).toEqual([]);
  });

  it('holds the order during a burst while the cells stay live, then applies it after 1 s quiet', async () => {
    await open('/turbines');
    const before = ids();
    expect(before.indexOf('TURB007')).toBeGreaterThan(0);

    await push('TURB007', 'FARM02', 2345);
    expect(cells('TURB007')).toContain('2,345');
    expect(cells('TURB007')).toContain('Reporting');
    expect(ids()).toEqual(before);

    await wait(ORDER_QUIET_MS - 1);
    expect(ids()).toEqual(before);
    expect(reorder).not.toHaveBeenCalled();

    await wait(1);
    expect(ids()[0]).toBe('TURB007');
    expect(reorder).toHaveBeenCalledOnce();
  });

  it('applies the order at the 3 s cap while the burst goes on, once', async () => {
    await open('/turbines');
    const before = ids();
    const burst = ['TURB007', 'TURB006', 'TURB002', 'TURB003', 'TURB005', 'TURB001'];
    const farmOf = new Map(
      mixedFleetFixture().flatMap((f) => f.turbines.map((t) => [t.id, t.farmId])),
    );
    const step = ORDER_QUIET_MS / 2;

    // A new reading every 500 ms, so it never goes quiet for 1 s.
    let elapsed = 0;
    for (const id of burst) {
      await push(id, farmOf.get(id)!);
      if (elapsed + step < ORDER_MAX_HOLD_MS) {
        await wait(step);
        elapsed += step;
        expect(ids()).toEqual(before);
      }
    }
    expect(elapsed).toBe(ORDER_MAX_HOLD_MS - step);

    await wait(step);
    expect(reorder).toHaveBeenCalledOnce();
    expect(ids()).not.toEqual(before);
  });

  it('applies a sort at once during a burst, without a glide', async () => {
    await open('/turbines');
    await push('TURB007', 'FARM02', 9999);

    clickSort('power');
    clickSort('power'); // highest first

    expect(ids()[0]).toBe('TURB007');
    await wait(ORDER_MAX_HOLD_MS);
    expect(reorder).not.toHaveBeenCalled(); // the timer finds the order already applied
  });

  it('applies a filter at once during a burst, in the newest order', async () => {
    await open('/turbines');
    const before = ids();
    await push('TURB007', 'FARM02');
    expect(ids()).toEqual(before);

    await type('FARM02');

    expect(ids()[0]).toBe('TURB007');
    await wait(ORDER_MAX_HOLD_MS);
    expect(reorder).not.toHaveBeenCalled();
  });

  it('cancels a glide in flight when the sort changes', async () => {
    await open('/turbines');
    const cancel = vi.spyOn(RowGlide.prototype, 'cancel');
    cancel.mockClear();

    clickSort('power');

    expect(cancel).toHaveBeenCalledOnce();
  });

  it('applies another farm at once', async () => {
    await open('/farms/FARM02');
    await push('TURB007', 'FARM02');

    await TestBed.inject(Router).navigateByUrl('/farms/FARM01');
    TestBed.tick();

    const expected = mixedFleetFixture()
      .find((f) => f.id === 'FARM01')!
      .turbines.map((t) => t.id);
    expect(ids().sort()).toEqual(expected.sort());
    expect(reorder).not.toHaveBeenCalled();
  });

  it('shows a hidden turbine at once when it first reports, in its place once the order applies', async () => {
    await open('/turbines');
    expect(ids()).not.toContain('TURB004');

    await push('TURB004', 'FARM02');
    expect(ids().at(-1)).toBe('TURB004'); // never lost: last so far, as it had no reading
    expect(row('TURB004').hasAttribute('data-updated')).toBe(true);

    await wait(ORDER_QUIET_MS);
    expect(ids()[0]).toBe('TURB004');
  });

  it('never loses or repeats a row across pages while the order is held', async () => {
    const fleet = largeFleetFixture(60); // all equally new: by id
    await open('/turbines', fleet);
    /** The paginator's own buttons: harnesses would wait on the faked scheduler. */
    const button = (label: string) =>
      app.root().querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    const onPage: string[][] = [];
    const walk = () => {
      onPage.length = 0;
      while (!button('Previous page').disabled) {
        button('Previous page').click();
        TestBed.tick();
      }
      for (;;) {
        onPage.push(ids());
        if (button('Next page').disabled) break;
        button('Next page').click();
        TestBed.tick();
      }
      return onPage.flat();
    };
    const allIds = walk();
    expect(new Set(allIds).size).toBe(60);

    // TURB060 (on page 3) gets a newer reading: its row stays on page 3 until the order settles.
    await push('TURB060', 'FARM01', 7777);
    expect(ids()).not.toContain('TURB060');
    expect(walk()).toEqual(allIds);
    expect(onPage.at(-1)).toContain('TURB060');

    await wait(ORDER_MAX_HOLD_MS);
    const settled = walk();
    expect(settled[0]).toBe('TURB060');
    expect(new Set(settled).size).toBe(60);
  });

  it('clears its order timers when destroyed', async () => {
    await open('/turbines');
    await push('TURB007', 'FARM02');

    await TestBed.inject(Router).navigateByUrl('/settings');
    TestBed.tick();

    await wait(ORDER_MAX_HOLD_MS);
    expect(reorder).not.toHaveBeenCalled();
  });
});
