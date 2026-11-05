import { HttpErrorResponse } from '@angular/common/http';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject, map, of, throwError } from 'rxjs';
import { AuthStore } from '../core/auth/auth.store';
import { SseService } from '../core/sse.service';
import { FleetApi } from './fleet-api.service';
import { TurbinePageResponse, TurbineResponse } from './fleet.model';
import { FLASH_MS, FleetStore } from './fleet.store';
import { FarmOverview, fakes, largeFleetFixture, mixedFleetFixture, reading } from './testing';
import {
  FILTER_DEBOUNCE_MS,
  LIVE_BATCH_MS,
  TOTAL_DISPLAY_CAP,
  TURBINE_PAGE_SIZE,
  TurbinePageStore,
  WATCH_DEBOUNCE_MS,
  commissionedErrorMessage,
} from './turbine-page.store';

/** The client clock: 5 minutes after TURB001's latest reading (23:55). */
const NOW = Date.parse('2026-01-03T00:00:00.000Z');
const AT_NOW = '2026-01-03T00:00:00.000Z';
const MINUTE = 60_000;

const fakeAuth = () => ({ isAuthenticated: signal(true) });

describe('TurbinePageStore', () => {
  beforeEach(() => vi.useFakeTimers({ now: NOW }));
  afterEach(() => vi.useRealTimers());

  function setup(farms: FarmOverview[] = mixedFleetFixture()) {
    const { api, sse } = fakes(farms);
    const auth = fakeAuth();
    TestBed.configureTestingModule({
      providers: [
        FleetStore,
        TurbinePageStore,
        { provide: FleetApi, useValue: api },
        { provide: SseService, useValue: sse },
        { provide: AuthStore, useValue: auth },
      ],
    });
    const fleet = TestBed.inject(FleetStore);
    fleet.init();
    const store = TestBed.inject(TurbinePageStore);
    /** Change detection (effects, the resource's request) and the microtasks of its answer. */
    const flush = async () => {
      TestBed.tick();
      await vi.advanceTimersByTimeAsync(0);
      TestBed.tick();
    };
    const ids = () => store.rows().map((r) => r.id);
    const lastQuery = () => api.turbines.mock.lastCall![0];
    /** A scoped store with its first page loaded. */
    const open = async (farmId: string | null = null) => {
      store.setScope(farmId);
      await flush();
    };
    return { store, fleet, api, sse, auth, flush, ids, lastQuery, open };
  }

  describe('the query', () => {
    it('sends no request until the table says which scope it shows', async () => {
      const { api, flush } = setup();

      await flush();

      expect(api.turbines).not.toHaveBeenCalled();
    });

    it('asks for the whole fleet, newest reading first, hiding turbines that never reported', async () => {
      const { store, api, lastQuery, open } = setup();

      await open(null);

      expect(api.turbines).toHaveBeenCalledOnce();
      expect(lastQuery()).toEqual({
        sort: 'time',
        dir: 'desc',
        limit: TURBINE_PAGE_SIZE,
        hasData: true,
      });
      expect(store.loaded()).toBe(true);
    });

    it("asks for one farm's turbines when scoped to it", async () => {
      const { ids, lastQuery, open } = setup();

      await open('FARM02');

      expect(lastQuery().farmId).toBe('FARM02');
      expect(ids()).toEqual(['TURB002', 'TURB006', 'TURB007']);
    });

    it('sends the same scope only once', async () => {
      const { store, api, flush, open } = setup();
      await open('FARM01');

      store.setScope('FARM01');
      await flush();

      expect(api.turbines).toHaveBeenCalledOnce();
    });

    it('sends asOf (the client clock) only with a status filter, and asks again each minute', async () => {
      const { store, api, fleet, lastQuery, flush, open } = setup(largeFleetFixture(60));
      await open(null);
      expect(lastQuery().asOf).toBeUndefined();
      await vi.advanceTimersByTimeAsync(MINUTE);
      await flush();
      expect(api.turbines).toHaveBeenCalledOnce();

      store.setStatus('reporting');
      await flush();
      store.next();
      await flush();
      const sent = api.turbines.mock.calls.length;
      expect(lastQuery().asOf).toBe(new Date(fleet.now()).toISOString());

      await vi.advanceTimersByTimeAsync(MINUTE);
      await flush();

      expect(api.turbines.mock.calls.length).toBe(sent + 1);
      expect(lastQuery()).toMatchObject({ status: 'reporting', cursor: '25' });
      expect(lastQuery().asOf).toBe(new Date(fleet.now()).toISOString());
      expect(store.paging.pageIndex()).toBe(1);
    });

    it('asks once per minute, not when a live reading moves the clock mid-minute', async () => {
      const { store, api, sse, flush, open } = setup();
      await open(null);
      store.setStatus('reporting');
      await flush();
      const sent = api.turbines.mock.calls.length;

      await vi.advanceTimersByTimeAsync(MINUTE / 2);
      sse.push(reading({ turbineId: 'TURB001', farmId: 'FARM01', timestamp: AT_NOW }));
      await flush();
      expect(api.turbines.mock.calls.length).toBe(sent);

      await vi.advanceTimersByTimeAsync(MINUTE / 2);
      await flush();
      expect(api.turbines.mock.calls.length).toBe(sent + 1);

      await vi.advanceTimersByTimeAsync(MINUTE - 1);
      await flush();
      expect(api.turbines.mock.calls.length).toBe(sent + 1);
    });

    it('does not ask again each minute before the first page has loaded', async () => {
      const { store, api, flush } = setup();
      const first = new Subject<TurbinePageResponse>();
      api.turbines.mockReturnValue(first);
      store.setStatus('stale');
      store.setScope(null);
      await flush();
      expect(api.turbines).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(MINUTE);
      await flush();

      expect(api.turbines).toHaveBeenCalledOnce();
    });

    it('does not ask again each minute before the table has said which scope it shows', async () => {
      const { store, api, flush } = setup();
      store.setStatus('stale');

      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      await flush();

      expect(api.turbines).not.toHaveBeenCalled();
    });

    it('lets a user action win over a minute refetch still in flight', async () => {
      const { store, api, ids, lastQuery, flush, open } = setup();
      await open(null);
      store.setStatus('stale');
      await flush();
      const slow = new Subject<TurbinePageResponse>();
      api.turbines.mockReturnValueOnce(slow);
      await vi.advanceTimersByTimeAsync(MINUTE);
      await flush();
      expect(slow.observed).toBe(true);

      store.setStatus('reporting');
      await flush();

      expect(slow.observed).toBe(false);
      expect(lastQuery().status).toBe('reporting');
      slow.next({ items: [], nextCursor: null, prevCursor: null, total: 0, totalCapped: false });
      await flush();
      expect(ids().length).toBeGreaterThan(0);
      expect(store.loading()).toBe(false);
    });

    it('shows no loading state during a minute refetch, and an emptied page keeps Previous', async () => {
      const { store, api, ids, flush, open } = setup(largeFleetFixture(60));
      await open(null);
      store.setStatus('reporting');
      await flush();
      store.next();
      await flush();
      expect(store.hasPrevious()).toBe(true);
      const tick = new Subject<TurbinePageResponse>();
      api.turbines.mockReturnValueOnce(tick);

      await vi.advanceTimersByTimeAsync(MINUTE);
      await flush();
      expect(store.loading()).toBe(false);
      expect(ids().length).toBeGreaterThan(0);

      tick.next({ items: [], nextCursor: null, prevCursor: '0', total: 25, totalCapped: false });
      await flush();

      expect(ids()).toEqual([]);
      expect(store.loading()).toBe(false);
      expect(store.hasPrevious()).toBe(true);
    });

    it('keeps the rows and shows no error when a minute refetch fails', async () => {
      const { store, api, ids, flush, open } = setup();
      await open(null);
      store.setStatus('stale');
      await flush();
      const rows = ids();
      api.turbines.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 500 })));

      await vi.advanceTimersByTimeAsync(MINUTE);
      await flush();

      expect(ids()).toEqual(rows);
      expect(store.failed()).toBe(false);
    });

    it('applies selects and switches at once, each from the first page', async () => {
      const { store, lastQuery, flush, open } = setup(largeFleetFixture(60));
      await open(null);
      store.next();
      await flush();
      expect(lastQuery().cursor).toBe('25');

      store.setStatus('stale');
      await flush();
      expect(lastQuery()).toMatchObject({ status: 'stale' });
      expect(lastQuery().cursor).toBeUndefined();

      store.next();
      store.setCommissionedFilter('no');
      await flush();
      expect(lastQuery()).toMatchObject({ commissioned: false });
      expect(lastQuery().cursor).toBeUndefined();

      store.setCommissionedFilter('yes');
      await flush();
      expect(lastQuery().commissioned).toBe(true);

      store.setHideNoData(false);
      await flush();
      expect(lastQuery().hasData).toBeUndefined();
    });

    it('lets the "No readings yet" status override the hide switch, and restores it after', async () => {
      const { store, lastQuery, flush, open } = setup();
      await open(null);
      expect(store.hidesNoData()).toBe(true);

      store.setStatus('no_data');
      await flush();
      expect(store.hidesNoData()).toBe(false);
      expect(store.hideNoData()).toBe(true); // the user's setting is kept
      expect(lastQuery().hasData).toBeUndefined();

      store.setStatus('all');
      await flush();
      expect(lastQuery().hasData).toBe(true);
    });

    describe('typed text', () => {
      it('waits for the typing to pause, then sends the trimmed text once', async () => {
        const { store, api, lastQuery, flush, open } = setup();
        await open(null);
        const sent = api.turbines.mock.calls.length;

        store.setQuery('T');
        await vi.advanceTimersByTimeAsync(FILTER_DEBOUNCE_MS - 1);
        store.setQuery('TURB ');
        await vi.advanceTimersByTimeAsync(FILTER_DEBOUNCE_MS - 1);
        await flush();
        expect(api.turbines.mock.calls.length).toBe(sent);
        expect(store.queryText()).toBe('TURB '); // the field itself follows at once

        await vi.advanceTimersByTimeAsync(1);
        await flush();
        expect(api.turbines.mock.calls.length).toBe(sent + 1);
        expect(lastQuery().q).toBe('TURB');
      });

      it('sends nothing when the text is back to what is already applied', async () => {
        const { store, api, flush, open } = setup();
        await open(null);
        store.setQuery('FARM01');
        await vi.advanceTimersByTimeAsync(FILTER_DEBOUNCE_MS);
        await flush();
        const sent = api.turbines.mock.calls.length;

        store.setQuery('FARM010');
        store.setQuery('FARM01'); // typed and deleted within the pause
        await vi.advanceTimersByTimeAsync(FILTER_DEBOUNCE_MS);
        await flush();

        expect(api.turbines.mock.calls.length).toBe(sent);
      });

      it('leaves blank text out of the query', async () => {
        const { store, lastQuery, flush, open } = setup();
        await open(null);

        store.setQuery('   ');
        await vi.advanceTimersByTimeAsync(FILTER_DEBOUNCE_MS);
        await flush();

        expect(lastQuery().q).toBeUndefined();
      });

      it('clears at once and cancels a pending apply', async () => {
        const { store, lastQuery, flush, open } = setup();
        await open(null);
        store.setQuery('FARM01');
        await vi.advanceTimersByTimeAsync(FILTER_DEBOUNCE_MS);
        await flush();
        expect(lastQuery().q).toBe('FARM01');

        store.setQuery('x'); // pending
        store.clearQuery();
        await flush();

        expect(store.queryText()).toBe('');
        expect(lastQuery().q).toBeUndefined();
        await vi.advanceTimersByTimeAsync(FILTER_DEBOUNCE_MS);
        await flush();
        expect(lastQuery().q).toBeUndefined();
      });

      it('goes back to the first page', async () => {
        const { store, lastQuery, flush, open } = setup(largeFleetFixture(60));
        await open(null);
        store.next();
        await flush();

        store.setQuery('TURB0');
        await vi.advanceTimersByTimeAsync(FILTER_DEBOUNCE_MS);
        await flush();

        expect(lastQuery().cursor).toBeUndefined();
      });
    });

    describe('sorting', () => {
      it('sorts by turbine, farm, commissioned and last reading anywhere', async () => {
        const { store, lastQuery, flush, open } = setup();
        await open(null);

        for (const key of ['id', 'farm', 'commissioned', 'time'] as const) {
          store.setSort({ key, dir: 'asc' });
          await flush();
          expect(lastQuery()).toMatchObject({ sort: key, dir: 'asc' });
        }
      });

      it('refuses a power, wind or gearbox sort without a farm: nothing changes or is sent', async () => {
        const { store, api, flush, open } = setup();
        await open(null);
        const sent = api.turbines.mock.calls.length;
        expect(store.canSortByMetric()).toBe(false);

        for (const key of ['power', 'wind', 'gearbox'] as const) {
          store.setSort({ key, dir: 'desc' });
        }
        await flush();

        expect(store.sort()).toEqual({ key: 'time', dir: 'desc' });
        expect(api.turbines.mock.calls.length).toBe(sent);
      });

      it('sorts by a metric within a farm', async () => {
        const { store, ids, lastQuery, flush, open } = setup();
        await open('FARM02');
        expect(store.canSortByMetric()).toBe(true);

        store.setSort({ key: 'power', dir: 'asc' });
        await flush();

        expect(lastQuery()).toMatchObject({ farmId: 'FARM02', sort: 'power', dir: 'asc' });
        expect(ids()).toEqual(['TURB006', 'TURB007', 'TURB002']);
      });

      it('falls back to the last reading when the scope widens to the whole fleet', async () => {
        const { store, lastQuery, flush, open } = setup();
        await open('FARM02');
        store.setSort({ key: 'wind', dir: 'asc' });
        await flush();

        store.setScope(null);
        await flush();

        expect(store.sort()).toEqual({ key: 'time', dir: 'desc' });
        expect(lastQuery()).toMatchObject({ sort: 'time', dir: 'desc' });
        expect(lastQuery().farmId).toBeUndefined();
      });

      it('keeps a metric sort when moving to another farm', async () => {
        const { store, lastQuery, flush, open } = setup();
        await open('FARM02');
        store.setSort({ key: 'power', dir: 'desc' });
        await flush();

        store.setScope('FARM01');
        await flush();

        expect(lastQuery()).toMatchObject({ farmId: 'FARM01', sort: 'power', dir: 'desc' });
      });
    });
  });

  describe('requests in flight', () => {
    it('drops the answer to a request a newer one replaced', async () => {
      const { store, api, ids, flush } = setup();
      const slow = new Subject<TurbinePageResponse>();
      api.turbines.mockReturnValueOnce(slow);
      store.setScope('FARM01');
      await flush();
      expect(slow.observed).toBe(true);

      store.setScope('FARM02'); // the table moved on
      await flush();

      expect(slow.observed).toBe(false);
      slow.next({ items: [], nextCursor: null, prevCursor: null, total: 99, totalCapped: false });
      await flush();
      expect(ids()).toEqual(['TURB002', 'TURB006', 'TURB007']);
      expect(store.totalLabel()).toBe('3');
    });

    it('shows loading while a request is out, and keeps the rows until the answer', async () => {
      const { store, api, ids, flush, open } = setup();
      await open('FARM02');
      const next = new Subject<TurbinePageResponse>();
      api.turbines.mockReturnValue(next);

      store.setStatus('stale');
      await flush();

      expect(store.loading()).toBe(true);
      expect(ids()).toEqual(['TURB002', 'TURB006', 'TURB007']);
    });

    it('sends nothing on retry before the scope is known', async () => {
      const { store, api, flush } = setup();

      store.retry();
      await flush();

      expect(api.turbines).not.toHaveBeenCalled();
    });

    it('fails with the previous rows kept, and retries the same query', async () => {
      const { store, api, ids, lastQuery, flush, open } = setup();
      await open('FARM02');
      api.turbines.mockReturnValue(throwError(() => new HttpErrorResponse({ status: 500 })));

      store.setStatus('stale');
      await flush();

      expect(store.failed()).toBe(true);
      expect(ids()).toEqual(['TURB002', 'TURB006', 'TURB007']);

      api.turbines.mockReset();
      api.turbines.mockReturnValue(
        of({ items: [], nextCursor: null, prevCursor: null, total: 0, totalCapped: false }),
      );
      store.retry();
      await flush();

      expect(api.turbines).toHaveBeenCalledOnce();
      expect(lastQuery()).toMatchObject({ farmId: 'FARM02', status: 'stale' });
      expect(store.failed()).toBe(false);
      expect(ids()).toEqual([]);
    });
  });

  describe('pages', () => {
    it("moves to the next page with the server's cursor, and back to the previous", async () => {
      const { store, ids, lastQuery, flush, open } = setup(largeFleetFixture(60));
      await open(null);
      expect(ids()).toHaveLength(25);
      expect([store.hasNext(), store.hasPrevious()]).toEqual([true, false]);

      store.next();
      await flush();
      expect(lastQuery().cursor).toBe('25');
      expect(ids()[0]).toBe('TURB026');
      expect([store.hasNext(), store.hasPrevious()]).toEqual([true, true]);

      store.next();
      await flush();
      expect(ids()).toHaveLength(10);
      expect([store.hasNext(), store.hasPrevious()]).toEqual([false, true]);

      store.previous();
      await flush();
      expect(ids()[0]).toBe('TURB026');
      store.previous();
      await flush();
      expect(ids()[0]).toBe('TURB001');
      expect(store.paging.rangeLabel()).toBe('1 – 25 of 60');
      expect(lastQuery().sort).toBe('time');
    });

    it('ignores next on the last page and previous on the first', async () => {
      const { store, api, flush, open } = setup();
      await open(null);
      const sent = api.turbines.mock.calls.length;

      store.next();
      store.previous();
      await flush();

      expect(api.turbines.mock.calls.length).toBe(sent);
    });

    it('feeds the paginator: a range label, a length that enables only the moves that exist', async () => {
      const { store, flush, open } = setup(largeFleetFixture(60));
      await open(null);
      expect(store.paging.rangeLabel()).toBe('1 – 25 of 60');
      expect(store.paging.pageIndex()).toBe(0);
      expect(store.paging.length()).toBe(50); // 25 shown + one more page

      store.next();
      await flush();
      store.next();
      await flush();
      expect(store.paging.rangeLabel()).toBe('51 – 60 of 60');
      expect(store.paging.length()).toBe(60); // nothing beyond
    });

    it('goes back to the first page when the server has no earlier cursor', async () => {
      const { store, api, lastQuery, flush, open } = setup(largeFleetFixture(60));
      const original = api.turbines.getMockImplementation()!;
      api.turbines.mockImplementation((query) =>
        original(query).pipe(map((page) => ({ ...page, prevCursor: null }))),
      );
      await open(null);
      store.next();
      await flush();
      expect(store.paging.pageIndex()).toBe(1);

      store.previous();
      await flush();

      expect(store.paging.pageIndex()).toBe(0);
      expect(lastQuery().cursor).toBeUndefined();
      expect(store.hasPrevious()).toBe(false);
    });

    describe('totalLabel', () => {
      it('is null before the first page', () => {
        expect(setup().store.totalLabel()).toBeNull();
      });

      it('groups thousands', async () => {
        const { store, api, flush, open } = setup();
        api.turbines.mockReturnValue(
          of({ items: [], nextCursor: null, prevCursor: null, total: 1234, totalCapped: false }),
        );
        await open(null);
        await flush();
        expect(store.totalLabel()).toBe('1,234');
      });

      it('says "10,000+" when the server counted only up to the cap', async () => {
        const { store, api, flush, open } = setup();
        api.turbines.mockReturnValue(
          of({
            items: [],
            nextCursor: 'c',
            prevCursor: null,
            total: TOTAL_DISPLAY_CAP + 1,
            totalCapped: true,
          }),
        );
        await open(null);
        await flush();
        expect(store.totalLabel()).toBe('10,000+');
        expect(store.paging.rangeLabel()).toBe('0 of 10,000+');
      });
    });
  });

  describe('live readings', () => {
    const push = (sse: ReturnType<typeof setup>['sse'], turbineId: string, overrides = {}) =>
      sse.push(
        reading({
          id: `${turbineId}-${overrides ? JSON.stringify(overrides) : ''}`,
          turbineId,
          farmId: turbineId === 'TURB001' ? 'FARM01' : 'FARM02',
          timestamp: AT_NOW,
          ...overrides,
        }),
      );
    const power = (store: TurbinePageStore, id: string) =>
      store.rows().find((r) => r.id === id)?.latest?.powerOutputKw;

    it('applies readings once a second, not when they arrive', async () => {
      const { store, sse, flush, open } = setup();
      await open(null);

      push(sse, 'TURB006', { powerOutputKw: 4321 });
      await flush();
      expect(power(store, 'TURB006')).toBe(300);

      await vi.advanceTimersByTimeAsync(LIVE_BATCH_MS - 1);
      expect(power(store, 'TURB006')).toBe(300);
      await vi.advanceTimersByTimeAsync(1);
      expect(power(store, 'TURB006')).toBe(4321);
    });

    it('puts a burst in one update and keeps the newest reading per turbine', async () => {
      const { store, sse, flush, open } = setup();
      await open(null);
      const spy = vi.fn();
      store.reorderWith = (change) => {
        spy();
        change();
      };

      push(sse, 'TURB006', { powerOutputKw: 1, timestamp: '2026-01-02T23:58:00.000Z' });
      push(sse, 'TURB006', { powerOutputKw: 3, timestamp: AT_NOW });
      push(sse, 'TURB006', { powerOutputKw: 2, timestamp: '2026-01-02T23:59:00.000Z' }); // older than queued
      push(sse, 'TURB007', { powerOutputKw: 7 });
      await vi.advanceTimersByTimeAsync(LIVE_BATCH_MS);
      await flush();

      expect(power(store, 'TURB006')).toBe(3);
      expect(power(store, 'TURB007')).toBe(7);
      expect(spy).toHaveBeenCalledOnce();
    });

    it('drops readings of turbines that are not on the page', async () => {
      const { store, sse, flush, open } = setup();
      await open('FARM02');

      push(sse, 'TURB001');
      push(sse, 'TURB999');
      await vi.advanceTimersByTimeAsync(LIVE_BATCH_MS);
      await flush();

      expect(store.recentlyUpdated().size).toBe(0);
      expect(store.rows().map((r) => r.id)).toEqual(['TURB002', 'TURB006', 'TURB007']);
    });

    it("ignores a reading that is not newer than the row's latest", async () => {
      const { store, sse, flush, open } = setup();
      await open(null);

      push(sse, 'TURB001', { timestamp: '2026-01-02T23:55:00.000Z', powerOutputKw: 1 }); // same instant
      push(sse, 'TURB003', { timestamp: '2026-01-02T23:30:00.000Z', powerOutputKw: 1 }); // older
      await vi.advanceTimersByTimeAsync(LIVE_BATCH_MS);
      await flush();

      expect(power(store, 'TURB001')).toBe(1960.5);
      expect(power(store, 'TURB003')).toBe(1500);
      expect(store.recentlyUpdated().size).toBe(0);
    });

    it('flashes each updated turbine for 2 s from its own update', async () => {
      const { store, sse, flush, open } = setup();
      await open(null);

      push(sse, 'TURB006');
      await vi.advanceTimersByTimeAsync(LIVE_BATCH_MS);
      await vi.advanceTimersByTimeAsync(500);
      push(sse, 'TURB007');
      await vi.advanceTimersByTimeAsync(LIVE_BATCH_MS);
      await flush();
      expect([...store.recentlyUpdated()].sort()).toEqual(['TURB006', 'TURB007']);

      await vi.advanceTimersByTimeAsync(FLASH_MS - LIVE_BATCH_MS - 500);
      expect([...store.recentlyUpdated()]).toEqual(['TURB007']);
      await vi.advanceTimersByTimeAsync(FLASH_MS - 500 - 1);
      expect(store.recentlyUpdated().has('TURB007')).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(store.recentlyUpdated().size).toBe(0);
    });

    it('restarts the flash when the same turbine updates again', async () => {
      const { store, sse, open } = setup();
      await open(null);

      push(sse, 'TURB006', { timestamp: '2026-01-02T23:58:00.000Z' });
      await vi.advanceTimersByTimeAsync(LIVE_BATCH_MS); // flashes until +2 s
      await vi.advanceTimersByTimeAsync(500);
      push(sse, 'TURB006', { timestamp: AT_NOW });
      await vi.advanceTimersByTimeAsync(LIVE_BATCH_MS); // updated again, still flashing: +2 s from now
      expect(store.recentlyUpdated().has('TURB006')).toBe(true);

      await vi.advanceTimersByTimeAsync(FLASH_MS - 1);
      expect(store.recentlyUpdated().has('TURB006')).toBe(true);
      await vi.advanceTimersByTimeAsync(1);
      expect(store.recentlyUpdated().size).toBe(0);
    });

    it('moves a turbine to the front when sorted by last reading, through reorderWith', async () => {
      const { store, ids, sse, flush, open } = setup();
      await open(null);
      const reorder = vi.fn((change: () => void) => change());
      store.reorderWith = reorder;
      expect(ids().indexOf('TURB007')).toBe(5);

      push(sse, 'TURB007');
      await vi.advanceTimersByTimeAsync(LIVE_BATCH_MS);
      await flush();

      expect(ids()[0]).toBe('TURB007');
      expect(reorder).toHaveBeenCalledOnce();
    });

    it('re-orders by power, wind and gearbox when the sort is by them', async () => {
      const { store, ids, sse, flush, open } = setup();
      await open('FARM02');
      store.setSort({ key: 'gearbox', dir: 'desc' });
      await flush();
      expect(ids()[0]).toBe('TURB006'); // 126.5

      push(sse, 'TURB007', { gearboxTempC: 140 });
      await vi.advanceTimersByTimeAsync(LIVE_BATCH_MS);
      await flush();

      expect(ids()[0]).toBe('TURB007');
    });

    it('breaks ties by turbine id and puts turbines without a value last, both ways', async () => {
      const { store, ids, sse, flush, open } = setup();
      await open('FARM02');
      store.setHideNoData(false);
      await flush();
      store.setSort({ key: 'power', dir: 'asc' });
      await flush();
      expect(ids().at(-1)).toBe('TURB004'); // never reported

      push(sse, 'TURB006', { powerOutputKw: 2259.3 }); // ties TURB002
      await vi.advanceTimersByTimeAsync(LIVE_BATCH_MS);
      await flush();
      expect(ids()).toEqual(['TURB007', 'TURB002', 'TURB006', 'TURB004']);

      store.setSort({ key: 'power', dir: 'desc' });
      await flush();
      push(sse, 'TURB007', { powerOutputKw: 50, timestamp: '2026-01-03T00:01:00.000Z' });
      await vi.advanceTimersByTimeAsync(LIVE_BATCH_MS);
      await flush();
      expect(ids()).toEqual(['TURB002', 'TURB006', 'TURB007', 'TURB004']);
    });

    it('updates cells but keeps the order under a sort readings do not change', async () => {
      const { store, ids, sse, flush, open } = setup();
      await open(null);
      store.setSort({ key: 'id', dir: 'asc' });
      await flush();
      const reorder = vi.fn((change: () => void) => change());
      store.reorderWith = reorder;
      const before = ids();

      push(sse, 'TURB007', { powerOutputKw: 55 });
      await vi.advanceTimersByTimeAsync(LIVE_BATCH_MS);
      await flush();

      expect(ids()).toEqual(before);
      expect(power(store, 'TURB007')).toBe(55);
      expect(reorder).not.toHaveBeenCalled();
    });

    it('applies the change without reorderWith too', async () => {
      const { store, ids, sse, flush, open } = setup();
      await open(null);
      store.reorderWith = null;

      push(sse, 'TURB007');
      await vi.advanceTimersByTimeAsync(LIVE_BATCH_MS);
      await flush();

      expect(ids()[0]).toBe('TURB007');
    });

    it.each([
      ['time', 'desc'],
      ['time', 'asc'],
      ['wind', 'desc'],
      ['wind', 'asc'],
      ['gearbox', 'asc'],
      ['power', 'desc'],
    ] as const)(
      'keeps turbines that never reported last when re-ordering by %s %s',
      async (key, dir) => {
        const { store, ids, sse, flush, open } = setup();
        await open('FARM02');
        store.setHideNoData(false);
        await flush();
        store.setSort({ key, dir });
        await flush();
        expect(ids().at(-1)).toBe('TURB004'); // never reported

        push(sse, 'TURB007', { timestamp: '2026-01-03T00:01:00.000Z' });
        await vi.advanceTimersByTimeAsync(LIVE_BATCH_MS);
        await flush();

        expect(ids().at(-1)).toBe('TURB004');
        expect(ids()).toHaveLength(4);
      },
    );

    it('moves a turbine that never reported to the end, even if the page lists it first', async () => {
      const { store, api, ids, sse, flush, open } = setup();
      const original = api.turbines.getMockImplementation()!;
      api.turbines.mockImplementation((query) =>
        original(query).pipe(map((page) => ({ ...page, items: [...page.items].reverse() }))),
      );
      await open('FARM02');
      store.setHideNoData(false);
      await flush();
      expect(ids()[0]).toBe('TURB004'); // never reported, listed first by this server

      push(sse, 'TURB006', { timestamp: '2026-01-03T00:01:00.000Z' });
      await vi.advanceTimersByTimeAsync(LIVE_BATCH_MS);
      await flush();

      expect(ids()).toEqual(['TURB006', 'TURB002', 'TURB007', 'TURB004']);
    });

    it('staleness follows the client clock', async () => {
      const { store, fleet, flush, open } = setup();
      await open(null);
      expect(store.rows().find((r) => r.id === 'TURB001')!.staleness).toBe('ok');

      await vi.advanceTimersByTimeAsync(12 * MINUTE); // the store ticks each minute
      await flush();

      expect(fleet.now()).toBe(NOW + 12 * MINUTE);
      expect(store.rows().find((r) => r.id === 'TURB001')!.staleness).toBe('stale-15');
    });

    it('stops its timers when destroyed', async () => {
      const { sse, flush, open } = setup();
      await open(null);
      push(sse, 'TURB007');
      await vi.advanceTimersByTimeAsync(LIVE_BATCH_MS);
      await flush();

      TestBed.resetTestingModule();

      expect(vi.getTimerCount()).toBe(0);
    });

    it('stops a pending batch when destroyed', async () => {
      const { sse, open } = setup();
      await open(null);
      push(sse, 'TURB007');

      TestBed.resetTestingModule();

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe('fetching the page again', () => {
    it('does so each time the stream opens, once, and then rests (no loop)', async () => {
      const { api, sse, flush, open } = setup();
      await open(null);
      const sent = api.turbines.mock.calls.length;

      sse.status('open');
      await flush();
      expect(api.turbines.mock.calls.length).toBe(sent + 1);

      await vi.advanceTimersByTimeAsync(5 * MINUTE);
      await flush();
      expect(api.turbines.mock.calls.length).toBe(sent + 1);

      sse.status('reconnecting');
      sse.status('open');
      await flush();
      expect(api.turbines.mock.calls.length).toBe(sent + 2);
    });

    it('does so on fleet.changed, keeping the same query and page', async () => {
      const { api, sse, lastQuery, flush, open } = setup(largeFleetFixture(60));
      await open(null);
      const sent = api.turbines.mock.calls.length;
      const store = TestBed.inject(TurbinePageStore);
      store.next();
      await flush();

      sse.pushEvent('fleet.changed', { turbineId: 'TURB001' });
      await flush();

      expect(api.turbines.mock.calls.length).toBe(sent + 2);
      expect(lastQuery().cursor).toBe('25');
    });

    it('shows the rows the new answer has, with a changed order', async () => {
      const farms = mixedFleetFixture();
      const { ids, sse, flush, open } = setup(farms);
      await open(null);
      expect(ids()[0]).toBe('TURB001');

      farms[0].turbines[0].latest = reading({
        turbineId: 'TURB001',
        timestamp: '2026-01-02T23:00:00.000Z',
      });
      sse.status('open');
      await flush();

      expect(ids()[0]).not.toBe('TURB001');
    });

    it('waits for a first page still on its way: it will be newer than the open', async () => {
      const { api, sse, flush } = setup();
      const first = new Subject<TurbinePageResponse>();
      api.turbines.mockReturnValue(first);
      const store = TestBed.inject(TurbinePageStore);
      store.setScope(null);
      await flush();
      expect(api.turbines).toHaveBeenCalledOnce();

      sse.status('open');
      await flush();

      expect(api.turbines).toHaveBeenCalledOnce();
    });
  });

  describe('telling the connection which turbines to carry', () => {
    it('sends the visible ids once the page has been stable for a moment', async () => {
      const { store, fleet, flush, open } = setup();
      const watch = vi.spyOn(fleet, 'watchTurbines');
      await open('FARM02');

      await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS - 1);
      expect(watch).not.toHaveBeenCalledWith(store, ['TURB002', 'TURB006', 'TURB007']);
      await vi.advanceTimersByTimeAsync(1);

      expect(watch).toHaveBeenLastCalledWith(store, ['TURB002', 'TURB006', 'TURB007']);
      await flush();
    });

    it('sends only the last page of a quick sequence of changes', async () => {
      const { store, fleet, flush, open } = setup();
      const watch = vi.spyOn(fleet, 'watchTurbines');
      await open('FARM02');
      await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS - 100);

      store.setScope('FARM01');
      await flush();
      await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS);

      const sent = watch.mock.calls.filter(([owner, ids]) => owner === store && ids.length);
      expect(sent.map(([, ids]) => ids)).toEqual([['TURB001', 'TURB003', 'TURB005']]);
    });

    it('does not resend the same ids after a refetch that changed nothing', async () => {
      const { store, fleet, sse, flush, open } = setup();
      await open('FARM02');
      await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS);
      const watch = vi.spyOn(fleet, 'watchTurbines');

      sse.status('open');
      await flush();
      await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS);

      expect(watch.mock.calls.filter(([owner]) => owner === store)).toHaveLength(0);
    });

    it("reconnects the stream for the page's ids (through the real FleetStore)", async () => {
      const { api, flush, open } = setup();
      await open('FARM02');
      await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS);
      await flush();

      expect(api.eventsUrl).toHaveBeenLastCalledWith(
        expect.arrayContaining(['TURB002', 'TURB006', 'TURB007']),
      );
    });

    it('lets go of its ids when destroyed', async () => {
      const { store, fleet, open } = setup();
      const watch = vi.spyOn(fleet, 'watchTurbines');
      await open('FARM02');
      await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS);

      TestBed.resetTestingModule();

      expect(watch).toHaveBeenLastCalledWith(store, []);
    });
  });

  describe('commissioned', () => {
    const answer = (commissioned: boolean, id = 'TURB002'): TurbineResponse => ({
      id,
      farmId: 'FARM02',
      latitude: 39.741,
      longitude: -101.207,
      commissioned,
    });
    /** A store whose PATCH answers only when the spec says so. */
    async function saving(farms = mixedFleetFixture()) {
      const app = setup(farms);
      const patch = new Subject<TurbineResponse>();
      app.api.setCommissioned.mockReturnValue(patch);
      await app.open(null);
      const value = (id = 'TURB002') => app.store.rows().find((r) => r.id === id)!.commissioned;
      /** The server saved it: later page requests see it. */
      const commit = (id: string, commissioned: boolean) => {
        for (const f of farms)
          for (const t of f.turbines) if (t.id === id) t.commissioned = commissioned;
        return answer(commissioned, id);
      };
      return { ...app, farms, patch, value, commit };
    }

    it('shows the new value at once and is pending until the answer, without another load', async () => {
      const { store, api, patch, value, flush, commit } = await saving();
      const loads = api.turbines.mock.calls.length;

      store.setCommissioned('TURB002', false);
      await flush();

      expect(api.setCommissioned).toHaveBeenCalledWith('TURB002', false);
      expect(value()).toBe(false);
      expect(store.commissionedPending()).toEqual(new Set(['TURB002']));

      patch.next(commit('TURB002', false));
      await flush();

      expect(value()).toBe(false);
      expect(store.commissionedPending().size).toBe(0);
      expect(store.commissionedError()).toBeNull();
      expect(api.turbines.mock.calls.length).toBe(loads);
    });

    it("shows the API's answer once it arrives", async () => {
      const { store, patch, value, flush } = await saving();

      store.setCommissioned('TURB002', false);
      patch.next(answer(true));
      await flush();

      expect(value()).toBe(true);
    });

    it('sends one request per turbine at a time, and tracks turbines separately', async () => {
      const { store, api, value, flush } = await saving();

      store.setCommissioned('TURB002', false);
      store.setCommissioned('TURB002', true);
      expect(api.setCommissioned).toHaveBeenCalledTimes(1);
      await flush();
      expect(value()).toBe(false);

      store.setCommissioned('TURB001', false);
      expect(store.commissionedPending()).toEqual(new Set(['TURB001', 'TURB002']));
      await flush();
      expect(value('TURB001')).toBe(false);
    });

    it('rolls back on failure, says why, loads the page again, and can be tried again', async () => {
      const { store, api, patch, value, flush, commit } = await saving();
      const loads = api.turbines.mock.calls.length;

      store.setCommissioned('TURB002', false);
      patch.error(
        new HttpErrorResponse({
          status: 400,
          error: { message: 'commissioned must be a boolean' },
        }),
      );
      await flush();

      expect(value()).toBe(true);
      expect(store.commissionedPending().size).toBe(0);
      expect(store.commissionedError()).toBe(
        'Could not mark TURB002 as not commissioned. commissioned must be a boolean.',
      );
      expect(api.turbines.mock.calls.length).toBe(loads + 1);

      api.setCommissioned.mockReturnValue(of(commit('TURB002', false)));
      store.setCommissioned('TURB002', false);
      await flush();

      expect(store.commissionedError()).toBeNull();
      expect(value()).toBe(false);
    });

    it('does not reload after a failure that signed the user out', async () => {
      const { store, api, auth, patch, value, flush } = await saving();
      const loads = api.turbines.mock.calls.length;

      store.setCommissioned('TURB002', false);
      auth.isAuthenticated.set(false);
      patch.error(new HttpErrorResponse({ status: 401 }));
      await flush();

      expect(value()).toBe(true);
      expect(api.turbines.mock.calls.length).toBe(loads);
    });

    it('is not flipped back by a page request answered while the PATCH is pending', async () => {
      const { store, api, patch, value, flush, farms, commit } = await saving();
      store.setCommissioned('TURB002', false);
      await flush();

      farms[1].turbines[0].commissioned = true; // read before the commit
      store.retry();
      await flush();
      expect(value()).toBe(false);
      expect(store.commissionedPending().has('TURB002')).toBe(true);

      patch.next(commit('TURB002', false));
      await flush();

      expect(value()).toBe(false);
      expect(store.commissionedPending().size).toBe(0);
      expect(api.turbines.mock.calls.length).toBeGreaterThan(1);
    });

    it('replaces a page request still in flight at the answer: its old value can never show', async () => {
      const { store, api, patch, value, flush, commit } = await saving();
      store.setCommissioned('TURB002', false);
      const stale = new Subject<TurbinePageResponse>();
      api.turbines.mockReturnValue(stale);
      store.retry();
      await flush();
      expect(stale.observed).toBe(true);

      api.turbines.mockImplementation(fakes(commitAll()).api.turbines);
      patch.next(commit('TURB002', false));
      await flush();

      expect(stale.observed).toBe(false);
      expect(value()).toBe(false);

      function commitAll() {
        return mixedFleetFixture().map((f) => ({
          ...f,
          turbines: f.turbines.map((t) => (t.id === 'TURB002' ? { ...t, commissioned: false } : t)),
        }));
      }
    });

    it('rolls back to what a page loaded meanwhile said, not to the value before the click', async () => {
      const { store, patch, value, flush, farms } = await saving();
      store.setCommissioned('TURB002', false);
      farms[1].turbines[0].commissioned = false; // it committed; the answer gets lost
      store.retry();
      await flush();

      patch.error(new HttpErrorResponse({ status: 0 }));
      await flush();

      expect(value()).toBe(false);
      expect(store.commissionedError()).toContain('Could not reach the API');
    });

    it('is not a reading: no flash, and the latest readings stay', async () => {
      const { store, patch, flush, commit } = await saving();
      const latest = store.rows().map((r) => r.latest);

      store.setCommissioned('TURB002', false);
      patch.next(commit('TURB002', false));
      await flush();

      expect(store.recentlyUpdated().size).toBe(0);
      expect(store.rows().map((r) => r.latest)).toEqual(latest);
    });

    it('merges only the value: the answer has no latest reading', async () => {
      const { store, patch, flush } = await saving();
      const before = store.rows().find((r) => r.id === 'TURB002')!;

      store.setCommissioned('TURB002', false);
      patch.next(answer(false)); // { id, farmId, latitude, longitude, commissioned }
      await flush();

      expect(store.rows().find((r) => r.id === 'TURB002')).toEqual({
        ...before,
        commissioned: false,
      });
    });

    it('loads the page again after a save only when a filter or the sort looks at the value', async () => {
      const { store, api, patch, flush, commit } = await saving();
      const loads = api.turbines.mock.calls.length;
      store.setCommissioned('TURB002', false);
      patch.next(commit('TURB002', false));
      await flush();
      expect(api.turbines.mock.calls.length).toBe(loads);

      store.setCommissionedFilter('yes');
      await flush();
      const filtered = api.turbines.mock.calls.length;
      store.setCommissioned('TURB001', false);
      api.setCommissioned.mockReturnValue(of(commit('TURB001', false)));
      await flush();
      expect(api.turbines.mock.calls.length).toBe(filtered); // already saving: ignored

      store.setCommissioned('TURB003', false);
      await flush();
      expect(api.turbines.mock.calls.length).toBeGreaterThan(filtered);
    });

    it('ignores an answer once the store is destroyed', async () => {
      const { store, patch, flush } = await saving();
      store.setCommissioned('TURB002', false);
      await flush();

      TestBed.resetTestingModule();

      expect(patch.observed).toBe(false);
    });

    it('words a 404, which never says why', () => {
      expect(
        commissionedErrorMessage(
          new HttpErrorResponse({ status: 404, error: { message: 'Cannot PATCH' } }),
          'TURB001',
          true,
        ),
      ).toBe(
        'Could not mark TURB001 as commissioned. The turbine no longer exists, or your account can no longer change it.',
      );
    });
  });
});
