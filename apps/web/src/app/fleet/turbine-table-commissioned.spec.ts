import { TestbedHarnessEnvironment } from '@angular/cdk/testing/testbed';
import { HttpErrorResponse } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { MatSlideToggleHarness } from '@angular/material/slide-toggle/testing';
import { Router } from '@angular/router';
import type { Mock } from 'vitest';
import { Subject, of } from 'rxjs';
import { Role } from '../core/auth/roles';
import { RowGlide } from '../ui/row-glide';
import { TurbineResponse } from './fleet.model';
import { FLASH_MS } from './fleet.store';
import { FarmOverview, largeFleetFixture, mixedFleetFixture, openFleet } from './testing';
import { LIVE_BATCH_MS } from './turbine-page.store';

/**
 * Changing a turbine's commissioned state in the turbines table (the mixed fleet at
 * 2026-01-03T00:00Z; TURB007 is not commissioned, the listed others are). Opens on real timers, then
 * time only moves in `wait()`, as in turbine-table-live.spec.ts.
 */
describe('TurbineTable commissioned control', () => {
  const CLOCK = Date.parse('2026-01-03T00:00:00.000Z');
  let app: Awaited<ReturnType<typeof openFleet>>;
  let reorder: Mock<RowGlide['reorder']>;
  let patch: Subject<TurbineResponse>;
  let farms: FarmOverview[];

  async function open(url = '/turbines', role: Role = 'owner', fleet = mixedFleetFixture()) {
    farms = fleet;
    app = await openFleet(url, () => CLOCK, farms, undefined, role);
    await app.stable();
    patch = new Subject<TurbineResponse>();
    app.api.setCommissioned.mockReturnValue(patch);
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
  /** The slide toggle's host, with our hooks. */
  const host = (id: string) => row(id).querySelector('[data-testid=commissioned-toggle]')!;
  /** The focusable switch inside it. Saving keeps it focusable: aria-disabled, not disabled. */
  const control = (id: string) => host(id).querySelector<HTMLButtonElement>('[role=switch]')!;
  const isOn = (id: string) => control(id).getAttribute('aria-checked') === 'true';
  const isSaving = (id: string) => control(id).getAttribute('aria-disabled') === 'true';
  const count = () => app.root().querySelector('[data-testid=turbine-count]')!;
  const cell = (id: string) => row(id).querySelector('[data-testid=commissioned-cell]')!;
  const error = () => app.root().querySelector('[data-testid=commissioned-error]');
  const flashing = () => ids().filter((id) => row(id).hasAttribute('data-updated'));
  const answer = (id: string, commissioned: boolean): TurbineResponse => ({
    id,
    farmId: 'FARM01',
    latitude: 40,
    longitude: -100,
    commissioned,
  });
  /** Runs the change detection and the microtasks a page request and its answer need. */
  async function flush() {
    TestBed.tick();
    await vi.advanceTimersByTimeAsync(0);
    TestBed.tick();
  }
  async function click(id: string) {
    control(id).click();
    await flush();
  }
  async function settle(run: () => void) {
    run();
    await flush();
  }
  /** The server saved the change: later page requests see it (the fake API reads `farms`). */
  function commit(id: string, commissioned: boolean) {
    for (const farm of farms) {
      for (const t of farm.turbines) if (t.id === id) t.commissioned = commissioned;
    }
    return answer(id, commissioned);
  }
  async function wait(ms: number) {
    await vi.advanceTimersByTimeAsync(ms);
    TestBed.tick();
  }
  async function choose(testId: string, value: string) {
    const select = app.root().querySelector<HTMLSelectElement>(`[data-testid=${testId}]`)!;
    select.value = value;
    select.dispatchEvent(new Event('change'));
    await flush();
  }
  async function sortByCommissioned() {
    app.root().querySelector<HTMLElement>('[data-testid=sort-commissioned]')!.click();
    await flush();
  }

  describe('by role', () => {
    it('shows viewers the check mark or X, and no control', async () => {
      await open('/turbines', 'viewer');

      expect(table().querySelector('[data-testid=commissioned-toggle]')).toBeNull();
      expect(
        cell('TURB001').querySelector('[data-testid=commissioned-icon]')!.getAttribute('data-icon'),
      ).toBe('check');
      expect(app.text(cell('TURB001'))).toBe('Commissioned');
    });

    for (const role of ['owner', 'admin'] as const) {
      it(`gives ${role}s a named switch showing the value, instead of the icon`, async () => {
        await open('/turbines', role);
        vi.useRealTimers(); // harnesses wait for stability
        const toggle = (id: string) =>
          TestbedHarnessEnvironment.loader(app.harness.fixture).getHarness(
            MatSlideToggleHarness.with({
              ancestor: `tr[data-turbine-id=${id}]`,
              selector: '[data-testid=commissioned-toggle]',
            }),
          );

        expect(await (await toggle('TURB001')).getAriaLabel()).toBe('Mark TURB001 as commissioned');
        expect(await (await toggle('TURB001')).isChecked()).toBe(true);
        expect(await (await toggle('TURB007')).isChecked()).toBe(false);
        expect(table().querySelector('[data-testid=commissioned-icon]')).toBeNull();
        expect(app.text(cell('TURB001'))).toBe('');
        expect(cell('TURB001').getAttribute('data-commissioned')).toBe('true');

        patch.next(commit('TURB007', true));
        patch.complete();
        await (await toggle('TURB007')).toggle();
        expect(app.api.setCommissioned).toHaveBeenCalledWith('TURB007', true);
        expect(await (await toggle('TURB007')).isChecked()).toBe(true);
      });
    }

    it('is on the farm page too', async () => {
      await open('/farms/FARM02');

      await click('TURB007');

      expect(app.api.setCommissioned).toHaveBeenCalledWith('TURB007', true);
    });
  });

  it('updates the cell at once and waits, disabled, until the answer', async () => {
    await open();

    await click('TURB007');

    expect(app.api.setCommissioned).toHaveBeenCalledWith('TURB007', true);
    expect(isOn('TURB007')).toBe(true);
    expect(isSaving('TURB007')).toBe(true);
    expect(host('TURB007').hasAttribute('data-pending')).toBe(true);
    expect(cell('TURB007').getAttribute('data-commissioned')).toBe('true');
    expect(isSaving('TURB001')).toBe(false);

    await settle(() => patch.next(commit('TURB007', true)));

    expect(isOn('TURB007')).toBe(true);
    expect(isSaving('TURB007')).toBe(false);
    expect(host('TURB007').hasAttribute('data-pending')).toBe(false);
  });

  it('rolls back on failure with an alert, and the row keeps working', async () => {
    await open();
    expect(error()).toBeNull();

    await click('TURB007');
    await settle(() => patch.error(new HttpErrorResponse({ status: 500 })));

    expect(isOn('TURB007')).toBe(false);
    expect(isSaving('TURB007')).toBe(false);
    expect(cell('TURB007').getAttribute('data-commissioned')).toBe('false');
    expect(error()!.getAttribute('role')).toBe('alert');
    expect(app.text(error())).toBe(
      'Could not mark TURB007 as commissioned. The request failed (HTTP 500).',
    );

    app.api.setCommissioned.mockReturnValue(of(answer('TURB007', true)));
    await click('TURB007');

    expect(error()).toBeNull();
    expect(isOn('TURB007')).toBe(true);
  });

  it('puts the control back when the request fails before a render', async () => {
    await open();
    app.api.setCommissioned.mockImplementation(() => {
      const failed = new Subject<TurbineResponse>();
      failed.error(new HttpErrorResponse({ status: 500 }));
      return failed;
    });

    await click('TURB007');

    expect(isOn('TURB007')).toBe(false);
  });

  it('forgets the error when the table goes away', async () => {
    await open();
    await click('TURB007');
    await settle(() => patch.error(new HttpErrorResponse({ status: 500 })));
    expect(error()).not.toBeNull();

    await TestBed.inject(Router).navigateByUrl('/settings');
    TestBed.tick();
    await TestBed.inject(Router).navigateByUrl('/turbines');
    TestBed.tick();

    expect(error()).toBeNull();
  });

  it('is not flipped back by a fleet.changed reload while saving', async () => {
    await open();
    await click('TURB007');

    await settle(() => app.sse.pushEvent('fleet.changed', { turbineId: 'TURB007' }));

    expect(app.api.farmSummaries).toHaveBeenCalledTimes(2);
    expect(isOn('TURB007')).toBe(true);
    expect(isSaving('TURB007')).toBe(true);
  });

  it('does not navigate or reach the row when clicked', async () => {
    await open();
    const url = TestBed.inject(Router).url;
    const rowClick = vi.fn();
    row('TURB007').addEventListener('click', rowClick);

    await click('TURB007');

    expect(rowClick).not.toHaveBeenCalled();
    expect(TestBed.inject(Router).url).toBe(url);
  });

  describe('filter', () => {
    it('keeps the row until the save is confirmed, then loads the page without it', async () => {
      await open();
      await choose('commissioned-filter', 'no');
      expect(ids()).toEqual(['TURB007']);

      await click('TURB007');
      expect(ids()).toEqual(['TURB007']); // shown as saving, not yet gone
      expect(isOn('TURB007')).toBe(true);

      await settle(() => patch.next(commit('TURB007', true)));
      expect(ids()).toEqual([]);
      expect(app.text(count())).toContain('0 of');
    });

    it('keeps the row, switched back, when the save fails', async () => {
      await open();
      await choose('commissioned-filter', 'no');

      await click('TURB007');
      await settle(() => patch.error(new HttpErrorResponse({ status: 500 })));

      expect(ids()).toEqual(['TURB007']);
      expect(isOn('TURB007')).toBe(false);

      await wait(LIVE_BATCH_MS);
      expect(reorder).not.toHaveBeenCalled();
    });

    it('asks the server for the commissioning filter', async () => {
      await open();
      await choose('commissioned-filter', 'yes');

      expect(app.api.turbines).toHaveBeenLastCalledWith(
        expect.objectContaining({ commissioned: true }),
      );
      expect(ids()).not.toContain('TURB007');
    });
  });

  describe('order', () => {
    it('moves the row when sorted by Commissioned once the save is confirmed: no glide, no flash', async () => {
      await open();
      await sortByCommissioned();
      expect(ids()).toEqual(['TURB001', 'TURB002', 'TURB003', 'TURB005', 'TURB006', 'TURB007']);

      await click('TURB001');
      expect(ids()).toEqual(['TURB001', 'TURB002', 'TURB003', 'TURB005', 'TURB006', 'TURB007']);

      await settle(() => patch.next(commit('TURB001', false)));
      await wait(LIVE_BATCH_MS);

      expect(ids()).toEqual(['TURB002', 'TURB003', 'TURB005', 'TURB006', 'TURB001', 'TURB007']);
      expect(reorder).not.toHaveBeenCalled();
      expect(flashing()).toEqual([]);
    });

    it('leaves the rows alone under any other sort: no move, no glide, no flash', async () => {
      await open();
      const before = ids();

      await click('TURB007');
      expect(flashing()).toEqual([]);
      await settle(() => patch.next(commit('TURB007', true)));
      await wait(Math.max(LIVE_BATCH_MS, FLASH_MS));

      expect(ids()).toEqual(before);
      expect(reorder).not.toHaveBeenCalled();
      expect(flashing()).toEqual([]);
    });

    it('loads the page again after a save only when a filter or the sort looks at the value', async () => {
      await open();
      const loads = app.api.turbines.mock.calls.length;

      await click('TURB007');
      await settle(() => patch.next(commit('TURB007', true)));

      expect(app.api.turbines.mock.calls.length).toBe(loads);
    });

    it('loads the page again when a page request overlapped the save', async () => {
      await open();
      await click('TURB007');
      const loads = app.api.turbines.mock.calls.length;
      await settle(() => app.sse.status('open')); // a refetch while the PATCH is out
      expect(app.api.turbines.mock.calls.length).toBe(loads + 1);

      await settle(() => patch.next(commit('TURB007', true)));

      expect(app.api.turbines.mock.calls.length).toBe(loads + 2);
      expect(isOn('TURB007')).toBe(true);
    });
  });

  describe('focus', () => {
    async function focusAndClick(id: string) {
      control(id).focus();
      await click(id);
    }
    const active = () => document.activeElement;

    it('stays on the switch while saving, and a second click is ignored', async () => {
      await open();

      await focusAndClick('TURB007');
      expect(control('TURB007').disabled).toBe(false);
      expect(active()).toBe(control('TURB007'));

      await click('TURB007');
      expect(app.api.setCommissioned).toHaveBeenCalledOnce();

      await settle(() => patch.next(commit('TURB007', true)));
      expect(active()).toBe(control('TURB007'));
    });

    it('follows the row when a Commissioned sort moves it after the save', async () => {
      await open();
      await sortByCommissioned();

      await focusAndClick('TURB001');
      expect(ids().indexOf('TURB001')).toBe(0);

      await settle(() => patch.next(commit('TURB001', false)));
      expect(ids().indexOf('TURB001')).toBe(4);
      expect(active()).toBe(control('TURB001'));
    });

    it('stays on the switch through a rollback', async () => {
      await open();
      await sortByCommissioned();

      await focusAndClick('TURB001');
      await settle(() => patch.error(new HttpErrorResponse({ status: 500 })));

      expect(ids().indexOf('TURB001')).toBe(0);
      expect(active()).toBe(control('TURB001'));
    });

    it('goes to the match count when a commissioning filter removes the row', async () => {
      await open();
      await choose('commissioned-filter', 'no');

      await focusAndClick('TURB007');
      await settle(() => patch.next(commit('TURB007', true)));

      expect(ids()).toEqual([]);
      expect(active()).toBe(count());
      expect(app.text(count())).toContain('0 of');
    });

    it('goes to the match count when the row sorts onto another page', async () => {
      await open('/turbines', 'owner', largeFleetFixture(30));
      await sortByCommissioned();
      const first = ids()[0];

      await focusAndClick(first);
      await settle(() => patch.next(commit(first, false)));

      expect(ids()).not.toContain(first);
      expect(active()).toBe(count());
    });

    it('leaves focus alone when it is not on a switch, or has moved on', async () => {
      await open();
      await sortByCommissioned();
      const search = app.root().querySelector<HTMLElement>('[data-testid=turbine-filter]')!;

      search.focus();
      await click('TURB001');
      await settle(() => patch.next(commit('TURB001', false)));

      expect(ids().indexOf('TURB001')).toBe(4);
      expect(active()).toBe(search);
    });
  });
});
