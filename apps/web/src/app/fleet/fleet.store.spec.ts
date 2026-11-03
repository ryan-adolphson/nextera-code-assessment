import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { WritableSignal, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { API_BASE_URL } from '../core/api-base-url';
import { Subject, of, throwError } from 'rxjs';
import { FakeEventSource } from '../../testing/fake-event-source';
import { AuthStore } from '../core/auth/auth.store';
import { NOW as NOW_TOKEN } from '../core/clock';
import { SseService } from '../core/sse.service';
import { FleetApi } from './fleet-api.service';
import { FarmOverview, LIVE_FUTURE_TOLERANCE_MS, Telemetry, TelemetryStats } from './fleet.model';
import { FLASH_MS, FleetStore, reconnectDelayMs } from './fleet.store';
import { fakes, farmsFixture, reading, statsFixture } from './testing';

/** The part of AuthStore the FleetStore reads: whether to keep retrying the live connection. */
const fakeAuth = (signedIn = true) => ({ isAuthenticated: signal(signedIn) });

/** The client clock in these tests: 5 minutes after TURB001's latest reading (23:55). */
const NOW = Date.parse('2026-01-03T00:00:00.000Z');
const HOUR = 3_600_000;
const MINUTE = 60_000;

describe('FleetStore', () => {
  // Fake timers drive the window's clock tick; the default NOW token reads the faked Date.now().
  beforeEach(() => vi.useFakeTimers({ now: NOW }));
  afterEach(() => vi.useRealTimers());

  function setup(farms: FarmOverview[] = farmsFixture()) {
    const { api, sse } = fakes(farms);
    TestBed.configureTestingModule({
      providers: [
        FleetStore,
        { provide: FleetApi, useValue: api },
        { provide: SseService, useValue: sse },
        { provide: AuthStore, useValue: fakeAuth() },
      ],
    });
    const store = TestBed.inject(FleetStore);
    store.init();
    return { store, api, sse };
  }

  it('subscribes to live readings before loading the fleet', () => {
    const { api, sse } = setup();

    expect(sse.connect).toHaveBeenCalledWith('http://api/events', [
      'telemetry.received',
      'alert-config.changed',
      'unallocated-turbine.changed',
      'fleet.changed',
    ]);
    expect(sse.connect.mock.invocationCallOrder[0]).toBeLessThan(
      api.farms.mock.invocationCallOrder[0],
    );
  });

  it('counts alert-config.changed events on the same connection, leaving readings alone', () => {
    const { store, sse } = setup();
    const latestBefore = store.turbines().map((t) => t.latest);

    sse.pushEvent('alert-config.changed', { action: 'created', id: 'r1' });
    sse.pushEvent('alert-config.changed', { action: 'deleted', id: 'r1' });

    expect(store.alertConfigVersion()).toBe(2);
    expect(store.turbines().map((t) => t.latest)).toEqual(latestBefore);
    expect(sse.connect).toHaveBeenCalledTimes(1);
  });

  it('counts unallocated-turbine.changed events on the same connection, reloading nothing else', () => {
    const { store, api, sse } = setup();

    sse.pushEvent('unallocated-turbine.changed', {
      action: 'held',
      id: 'e1',
      turbineId: 'TURB990',
    });
    sse.pushEvent('unallocated-turbine.changed', {
      action: 'blocked',
      id: 'e1',
      turbineId: 'TURB990',
    });

    expect(store.unallocatedVersion()).toBe(2);
    expect(store.alertConfigVersion()).toBe(0);
    expect(api.farms).toHaveBeenCalledTimes(1);
  });

  describe('fleet.changed (a turbine was assigned, kept or moved)', () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => (warn = vi.spyOn(console, 'warn').mockImplementation(() => {})));
    afterEach(() => warn.mockRestore());

    /** The fleet after TURB990 was assigned to FARM03, with its imported reading as latest. */
    const withAssigned = (latest: Telemetry | null) => {
      const fixture = farmsFixture();
      fixture[2].turbines.push({
        id: 'TURB990',
        farmId: 'FARM03',
        latitude: 35.12,
        longitude: -106.55,
        commissioned: false,
        latest,
      });
      return fixture;
    };
    const imported = (overrides: Partial<Telemetry> = {}) =>
      reading({
        id: 'imp-1',
        turbineId: 'TURB990',
        farmId: 'FARM03',
        timestamp: '2026-01-02T23:55:00.000Z',
        powerOutputKw: 640,
        ...overrides,
      });

    it('reloads the fleet quietly: the new turbine appears with its farm', () => {
      const { store, api, sse } = setup();
      api.farms.mockReturnValue(of(withAssigned(imported())));

      sse.pushEvent('fleet.changed', { turbineId: 'TURB990' });

      expect(api.farms).toHaveBeenCalledTimes(2);
      expect(store.loading()).toBe(false);
      expect(store.turbines().find((t) => t.id === 'TURB990')).toMatchObject({
        farmId: 'FARM03',
        farmName: 'Red Canyon',
        latest: { id: 'imp-1' },
      });
      expect(store.farms()[2].turbineCount).toBe(1);
    });

    it('keeps the imported reading that arrives (telemetry.received) before the reload answers', () => {
      const { store, api, sse } = setup();
      const farms = new Subject<FarmOverview[]>();
      api.farms.mockReturnValue(farms);

      // The API's order: fleet.changed, then the newest imported reading, while /farms loads.
      sse.pushEvent('fleet.changed', { turbineId: 'TURB990' });
      sse.push(imported({ id: 'imp-2', timestamp: '2026-01-03T00:00:00.000Z' }));
      expect(warn).not.toHaveBeenCalled();
      expect([...store.recentlyUpdated()]).toEqual(['TURB990']);

      // The reload predates nothing newer: its latest (23:55) is older than the live one.
      farms.next(withAssigned(imported()));
      expect(store.turbines().find((t) => t.id === 'TURB990')?.latest?.id).toBe('imp-2');
      expect(store.fleetTime()).toBe(Date.parse('2026-01-03T00:00:00.000Z'));
    });

    it('accepts the turbine only until a reload sent after the announcement answers', () => {
      const { store, api, sse } = setup();
      // A reload that (oddly) doesn't list it: the announcement ends with it.
      api.farms.mockReturnValue(of(farmsFixture()));
      sse.pushEvent('fleet.changed', { turbineId: 'TURB990' });

      sse.push(imported({ timestamp: '2026-01-03T00:00:00.000Z' }));

      expect(store.turbines().map((t) => t.id)).toEqual(['TURB001', 'TURB002']);
      expect(store.recentlyUpdated().size).toBe(0);
      expect(warn).toHaveBeenCalledOnce();
    });

    it('warns again about a turbine it had warned about before the announcement', () => {
      const { api, sse } = setup();
      sse.push(imported({ id: 'before' }));
      expect(warn).toHaveBeenCalledOnce();

      api.farms.mockReturnValue(of(farmsFixture()));
      sse.pushEvent('fleet.changed', { turbineId: 'TURB990' });
      sse.push(imported({ id: 'after', timestamp: '2026-01-03T00:00:00.000Z' }));

      expect(warn).toHaveBeenCalledTimes(2);
    });

    it('reloads without an announcement from a local reloadFleet()', () => {
      const { store, api } = setup();
      api.farms.mockReturnValue(of(withAssigned(null)));

      store.reloadFleet();

      expect(api.farms).toHaveBeenCalledTimes(2);
      expect(store.turbines().find((t) => t.id === 'TURB990')?.staleness).toBe('empty');
    });
  });

  describe('setCommissioned', () => {
    const answer = (commissioned: boolean, id = 'TURB002') => ({
      id,
      farmId: 'FARM02',
      latitude: 39.741,
      longitude: -101.207,
      commissioned,
    });
    /** The fleet as the server has it, with TURB002's value. */
    const fleetWith = (commissioned: boolean) => {
      const fleet = farmsFixture();
      fleet[1].turbines[0].commissioned = commissioned;
      return fleet;
    };
    const value = (store: FleetStore, id = 'TURB002') =>
      store.turbines().find((t) => t.id === id)!.commissioned;
    /** A store whose PATCH answers only when the spec says so. */
    function saving() {
      const app = setup();
      const patch = new Subject<ReturnType<typeof answer>>();
      app.api.setCommissioned.mockReturnValue(patch);
      return { ...app, patch };
    }

    it('shows the new value at once and is pending until the answer, without another load', () => {
      const { store, api, patch } = saving();

      store.setCommissioned('TURB002', true);

      expect(api.setCommissioned).toHaveBeenCalledWith('TURB002', true);
      expect(value(store)).toBe(true);
      expect(store.commissionedPending()).toEqual(new Set(['TURB002']));

      patch.next(answer(true));

      expect(value(store)).toBe(true);
      expect(store.commissionedPending().size).toBe(0);
      expect(store.commissionedError()).toBeNull();
      expect(api.farms).toHaveBeenCalledTimes(1);
    });

    it("shows the API's answer once it arrives", () => {
      const { store, patch } = saving();

      store.setCommissioned('TURB002', true);
      patch.next(answer(false));

      expect(value(store)).toBe(false);
    });

    it('sends one request per turbine at a time, and tracks turbines separately', () => {
      const { store, api } = saving();

      store.setCommissioned('TURB002', true);
      store.setCommissioned('TURB002', false);
      expect(api.setCommissioned).toHaveBeenCalledTimes(1);
      expect(value(store)).toBe(true);

      store.setCommissioned('TURB001', false);
      expect(store.commissionedPending()).toEqual(new Set(['TURB001', 'TURB002']));
      expect(value(store, 'TURB001')).toBe(false);
    });

    it('rolls back on failure, says why, reloads, and can be tried again', () => {
      const { store, api, patch } = saving();

      store.setCommissioned('TURB002', true);
      patch.error(
        new HttpErrorResponse({
          status: 400,
          error: { message: 'commissioned must be a boolean' },
        }),
      );

      expect(value(store)).toBe(false);
      expect(store.commissionedPending().size).toBe(0);
      expect(store.commissionedError()).toBe(
        'Could not mark TURB002 as commissioned. commissioned must be a boolean.',
      );
      expect(api.farms).toHaveBeenCalledTimes(2);

      api.setCommissioned.mockReturnValue(of(answer(true)));
      store.setCommissioned('TURB002', true);

      expect(store.commissionedError()).toBeNull();
      expect(value(store)).toBe(true);
    });

    it('words a 404, which never says why, and an un-commissioning', () => {
      const { store, api } = setup();
      api.setCommissioned.mockReturnValue(
        throwError(
          () => new HttpErrorResponse({ status: 404, error: { message: 'Cannot PATCH' } }),
        ),
      );

      store.setCommissioned('TURB001', false);

      expect(value(store, 'TURB001')).toBe(true);
      expect(store.commissionedError()).toBe(
        'Could not mark TURB001 as not commissioned. The turbine no longer exists, or your account can no longer change it.',
      );
    });

    it('does not reload after a failure that signed the user out', () => {
      const { store, api, patch } = saving();
      const auth = TestBed.inject(AuthStore) as unknown as ReturnType<typeof fakeAuth>;

      store.setCommissioned('TURB002', true);
      auth.isAuthenticated.set(false);
      patch.error(new HttpErrorResponse({ status: 401 }));

      expect(value(store)).toBe(false);
      expect(api.farms).toHaveBeenCalledTimes(1);
    });

    it('is not flipped back by a reload answered while the request is pending', () => {
      const { store, api, sse, patch } = saving();
      store.setCommissioned('TURB002', true);

      api.farms.mockReturnValue(of(fleetWith(false))); // read before the commit
      sse.pushEvent('fleet.changed', { turbineId: 'TURB001' });

      expect(api.farms).toHaveBeenCalledTimes(2);
      expect(value(store)).toBe(true);
      expect(store.commissionedPending().has('TURB002')).toBe(true);

      api.farms.mockReturnValue(of(fleetWith(true)));
      patch.next(answer(true));

      expect(value(store)).toBe(true);
      expect(store.commissionedPending().size).toBe(0);
    });

    it('replaces a load still in flight at the answer: its old value can never show', () => {
      const { store, api, sse, patch } = saving();
      const stale = new Subject<FarmOverview[]>();
      const fresh = new Subject<FarmOverview[]>();
      api.farms.mockReturnValue(stale);
      sse.pushEvent('fleet.changed', { turbineId: 'TURB001' });
      store.setCommissioned('TURB002', true);

      api.farms.mockReturnValue(fresh);
      patch.next(answer(true));

      expect(api.farms).toHaveBeenCalledTimes(3);
      expect(stale.observed).toBe(false);
      fresh.next(fleetWith(true));
      expect(value(store)).toBe(true);
    });

    it("after a load sent meanwhile, loads again: someone else's newer change wins", () => {
      const { store, api, sse, patch } = saving();
      store.setCommissioned('TURB002', true);
      // Ours commits, then another user's; their event's load has already been answered.
      api.farms.mockReturnValue(of(fleetWith(false)));
      sse.pushEvent('fleet.changed', { turbineId: 'TURB002' });

      patch.next(answer(true));

      expect(api.farms).toHaveBeenCalledTimes(3);
      expect(value(store)).toBe(false);
    });

    it('rolls back to what a reload meanwhile said, not to the value before the click', () => {
      const { store, api, sse, patch } = saving();
      store.setCommissioned('TURB002', true);
      api.farms.mockReturnValue(of(fleetWith(true))); // it committed; the answer gets lost
      sse.pushEvent('fleet.changed', { turbineId: 'TURB002' });

      patch.error(new HttpErrorResponse({ status: 0 }));

      expect(value(store)).toBe(true);
      expect(store.commissionedError()).toContain('Could not reach the API');
    });

    it('is not a reading: no flash, and the latest readings stay', () => {
      const { store, patch } = saving();
      const latest = store.turbines().map((t) => t.latest);

      store.setCommissioned('TURB002', true);
      patch.next(answer(true));

      expect(store.recentlyUpdated().size).toBe(0);
      expect(store.turbines().map((t) => t.latest)).toEqual(latest);
    });

    it('merges only the value: the answer has no latest reading, and a later reload keeps it', () => {
      const { store, patch } = saving();
      const before = store.turbines().find((t) => t.id === 'TURB002')!;

      store.setCommissioned('TURB002', true);
      patch.next(answer(true)); // { id, farmId, latitude, longitude, commissioned }

      expect(store.turbines().find((t) => t.id === 'TURB002')).toEqual({
        ...before,
        commissioned: true,
      });
      expect(before.latest).not.toBeNull();
      expect(before.staleness).toBe('ok');
    });

    it('ignores an answer once the store is destroyed', () => {
      const { store, patch } = saving();
      store.setCommissioned('TURB002', true);

      TestBed.resetTestingModule();

      expect(patch.observed).toBe(false);
      expect(store.commissionedError()).toBeNull();
    });
  });

  it('summarises the fleet and each farm from the latest readings', () => {
    const { store } = setup();

    expect(store.fleet()).toEqual({ farms: 3, turbines: 2, reporting: 2, powerKw: 4219.8 });
    expect(store.farms()[0]).toEqual({
      id: 'FARM01',
      name: 'Prairie Ridge',
      latitude: 41.25,
      longitude: -96.53,
      turbineCount: 1,
      reporting: 1,
      staleness: 'ok',
      powerKw: 1960.5,
      avgWindMs: 6.7,
    });
    expect(store.farms()[2]).toMatchObject({
      turbineCount: 0,
      powerKw: 0,
      avgWindMs: null,
      staleness: 'empty',
    });
  });

  it('applies a newer pushed reading and highlights the turbine', () => {
    const { store, sse } = setup();

    sse.push(reading({ timestamp: '2026-01-03T00:00:00.000Z', powerOutputKw: 3000 }));

    expect(store.turbines()[0].latest?.powerOutputKw).toBe(3000);
    expect([...store.recentlyUpdated()]).toEqual(['TURB001']);
  });

  describe('recentlyUpdated', () => {
    const push = (sse: ReturnType<typeof setup>['sse'], turbineId: string, timestamp: string) =>
      sse.push(reading({ id: `${turbineId}-${timestamp}`, turbineId, timestamp }));

    it('keeps every turbine of a burst for the whole flash', () => {
      const { store, sse } = setup();

      push(sse, 'TURB001', '2026-01-03T00:00:00.000Z');
      vi.advanceTimersByTime(500);
      push(sse, 'TURB002', '2026-01-03T00:00:00.000Z');
      expect([...store.recentlyUpdated()]).toEqual(['TURB001', 'TURB002']);

      vi.advanceTimersByTime(FLASH_MS - 501);
      expect(store.recentlyUpdated().has('TURB001')).toBe(true);
      vi.advanceTimersByTime(1);
      expect([...store.recentlyUpdated()]).toEqual(['TURB002']);
      vi.advanceTimersByTime(500);
      expect(store.recentlyUpdated().size).toBe(0);
    });

    it('restarts the time on another reading for the same turbine', () => {
      const { store, sse } = setup();

      push(sse, 'TURB001', '2026-01-02T23:58:00.000Z');
      vi.advanceTimersByTime(FLASH_MS - 1);
      push(sse, 'TURB001', '2026-01-03T00:00:00.000Z');
      vi.advanceTimersByTime(FLASH_MS - 1);
      expect(store.recentlyUpdated().has('TURB001')).toBe(true);
      vi.advanceTimersByTime(1);
      expect(store.recentlyUpdated().size).toBe(0);
    });

    it('clears its timers when destroyed', () => {
      const { sse } = setup();
      push(sse, 'TURB001', '2026-01-03T00:00:00.000Z');
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      TestBed.resetTestingModule(); // destroys the store

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it('ignores a late reading for an older instant (latest is by measurement time)', () => {
    const { store, sse } = setup();

    sse.push(
      reading({
        timestamp: '2026-01-02T23:40:00.000Z', // older than the current latest (23:55)
        receivedAt: '2026-01-03T00:05:00.000Z', // but arrived later
        powerOutputKw: 1,
      }),
    );

    expect(store.turbines()[0].latest?.powerOutputKw).toBe(1960.5);
    expect(store.recentlyUpdated().size).toBe(0);
  });

  it('dates the fleet ("data as of") by its newest reading, or not at all before any', () => {
    expect(setup().store.fleetTime()).toBe(Date.parse('2026-01-02T23:55:00.000Z'));
    TestBed.resetTestingModule();

    const silent = farmsFixture().map((f) => ({
      ...f,
      turbines: f.turbines.map((t) => ({ ...t, latest: null })),
    }));
    expect(setup(silent).store.fleetTime()).toBeNull();
  });

  it('ignores a re-delivered reading (exact duplicate of the latest)', () => {
    const { store, sse } = setup();
    const latest = farmsFixture()[0].turbines[0].latest!;

    sse.push({ ...latest });

    expect(store.turbines()[0].latest).toEqual(latest);
    expect(store.recentlyUpdated().size).toBe(0);
  });

  it('keeps the first reading for an instant when another arrives later for the same timestamp', () => {
    const { store, sse } = setup();

    sse.push(
      reading({
        timestamp: '2026-01-02T23:55:00.000Z', // the same instant as the current latest
        receivedAt: '2026-01-03T00:10:00.000Z', // received later: not newer data
        powerOutputKw: 1,
      }),
    );

    expect(store.turbines()[0].latest?.powerOutputKw).toBe(1960.5);
    expect(store.recentlyUpdated().size).toBe(0);
  });

  describe('a reading for a turbine the fleet does not list (e.g. added since the load)', () => {
    // The store warns about the ignored readings: silenced here, asserted where it matters.
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => (warn = vi.spyOn(console, 'warn').mockImplementation(() => {})));
    afterEach(() => warn.mockRestore());

    const unknown = (overrides: Partial<Telemetry> = {}) =>
      reading({
        id: 'new-1',
        turbineId: 'TURB999',
        farmId: 'FARM01',
        timestamp: '2026-01-03T00:00:00.000Z',
        powerOutputKw: 500,
        ...overrides,
      });

    it('changes nothing, and warns once per turbine', () => {
      const { store, sse } = setup();
      const before = {
        fleetTime: store.fleetTime(),
        fleet: store.fleet(),
        farms: store.farms(),
        turbines: store.turbines(),
      };

      sse.push(unknown());
      sse.push(unknown({ id: 'new-2', timestamp: '2026-01-03T00:05:00.000Z' }));

      expect(store.fleetTime()).toBe(before.fleetTime);
      expect(store.recentlyUpdated().size).toBe(0);
      expect(store.fleet()).toEqual(before.fleet);
      expect(store.farms()).toEqual(before.farms);
      expect(store.turbines()).toEqual(before.turbines);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0].join(' ')).toContain('TURB999');
    });

    it('does not move "data as of" past the listed turbines', () => {
      const { store, sse } = setup();
      const before = store.fleetTime();

      sse.push(unknown());

      expect(store.fleetTime()).toBe(before);
    });

    it('is ignored, so once a reload lists the turbine its latest comes from the API', () => {
      const { store, api, sse } = setup();
      sse.push(unknown());

      const fixture = farmsFixture();
      fixture[0].turbines.push({
        id: 'TURB999',
        farmId: 'FARM01',
        latitude: 41.26,
        longitude: -96.52,
        commissioned: false,
        latest: reading({
          id: 'api-1',
          turbineId: 'TURB999',
          farmId: 'FARM01',
          timestamp: '2026-01-02T23:55:00.000Z',
          powerOutputKw: 450,
        }),
      });
      api.farms.mockReturnValue(of(fixture));
      sse.fail(); // our own reconnect resyncs the fleet
      vi.advanceTimersByTime(1_000);
      sse.status('open');

      expect(store.turbines().find((t) => t.id === 'TURB999')).toMatchObject({
        latest: { id: 'api-1', powerOutputKw: 450 },
        staleness: 'ok',
      });

      // Now listed: its live readings apply.
      sse.push(unknown({ id: 'new-3', timestamp: '2026-01-03T00:05:00.000Z' }));
      expect(store.turbines().find((t) => t.id === 'TURB999')?.latest?.id).toBe('new-3');
      expect([...store.recentlyUpdated()]).toEqual(['TURB999']);
    });

    describe('before the first fleet load finishes (the listed turbines are not known yet)', () => {
      function setupPending() {
        const { api, sse } = fakes();
        const farms = new Subject<FarmOverview[]>();
        api.farms.mockReturnValue(farms);
        TestBed.configureTestingModule({
          providers: [
            FleetStore,
            { provide: FleetApi, useValue: api },
            { provide: SseService, useValue: sse },
            { provide: AuthStore, useValue: fakeAuth() },
          ],
        });
        const store = TestBed.inject(FleetStore);
        store.init();
        return { store, sse, farms };
      }

      it('keeps a reading for a turbine the loaded fleet lists', () => {
        const { store, sse, farms } = setupPending();
        expect(store.loading()).toBe(true);

        sse.push(
          reading({ id: 'early', timestamp: '2026-01-03T00:00:00.000Z', powerOutputKw: 3000 }),
        );
        farms.next(farmsFixture()); // the API's latest for TURB001 (23:55) is older

        expect(store.loading()).toBe(false);
        expect(store.turbines()[0].latest).toMatchObject({ id: 'early', powerOutputKw: 3000 });
        expect(store.fleetTime()).toBe(Date.parse('2026-01-03T00:00:00.000Z'));
        expect(warn).not.toHaveBeenCalled();
      });

      it('drops a reading for a turbine the loaded fleet does not list', () => {
        const { store, sse, farms } = setupPending();

        sse.push(unknown({ timestamp: '2026-01-03T00:05:00.000Z' }));
        farms.next(farmsFixture());

        expect(store.fleetTime()).toBe(Date.parse('2026-01-02T23:55:00.000Z'));
        expect(store.turbines().map((t) => t.id)).toEqual(['TURB001', 'TURB002']);
      });
    });
  });

  describe('a live reading dated ahead of the client clock', () => {
    let warn: ReturnType<typeof vi.spyOn>;
    beforeEach(() => (warn = vi.spyOn(console, 'warn').mockImplementation(() => {})));
    afterEach(() => warn.mockRestore());

    const ahead = (ms: number, overrides: Partial<Telemetry> = {}) =>
      reading({
        id: `ahead-${ms}`,
        timestamp: new Date(NOW + ms).toISOString(),
        powerOutputKw: 3000,
        ...overrides,
      });

    it.each([
      ['9 min 59 s', 10 * MINUTE - 1_000],
      ['exactly 10 min', LIVE_FUTURE_TOLERANCE_MS],
    ])('is applied %s ahead', (_, ms) => {
      const { store, sse } = setup();

      sse.push(ahead(ms));

      expect(store.turbines()[0].latest?.id).toBe(`ahead-${ms}`);
      expect(store.fleetTime()).toBe(NOW + ms);
      expect([...store.recentlyUpdated()]).toEqual(['TURB001']);
      expect(warn).not.toHaveBeenCalled();
    });

    it('is ignored more than 10 min ahead (10 min 1 s), with a warning', () => {
      const { store, sse } = setup();
      const before = { fleetTime: store.fleetTime(), latest: store.turbines()[0].latest };

      sse.push(ahead(10 * MINUTE + 1_000));

      expect(store.fleetTime()).toBe(before.fleetTime);
      expect(store.turbines()[0].latest).toEqual(before.latest);
      expect(store.recentlyUpdated().size).toBe(0);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn.mock.calls[0].join(' ')).toMatch(/TURB001.*2026-01-03T00:10:01\.000Z/);
    });

    it("does not reach the selected turbine's chart or table", () => {
      const { store, api, sse } = setup();
      store.select('TURB001');
      const statsCalls = api.telemetryStats.mock.calls.length;

      sse.push(ahead(10 * MINUTE + 1_000));
      vi.advanceTimersByTime(11 * MINUTE); // the clock passes the reading's time

      expect(store.history()).toEqual([]);
      expect(api.telemetryStats).toHaveBeenCalledTimes(statsCalls);
    });
  });

  describe('staleness (age of the latest reading on the client clock)', () => {
    // TURB001 and TURB002 last reported at 23:55; the clock starts at 00:00 (5 min later).
    const levels = (store: FleetStore) => store.turbines().map((t) => t.staleness);

    it('moves every turbine through 15/30/60 min on the minute tick, with nothing selected', () => {
      const { store } = setup();
      expect(store.selectedTurbineId()).toBeNull();
      expect(levels(store)).toEqual(['ok', 'ok']);

      vi.advanceTimersByTime(10 * MINUTE); // 00:10: exactly 15 min old, still reporting
      expect(levels(store)).toEqual(['ok', 'ok']);
      vi.advanceTimersByTime(MINUTE); // 00:11: 16 min
      expect(levels(store)).toEqual(['stale-15', 'stale-15']);
      expect(store.fleet().reporting).toBe(0);

      vi.advanceTimersByTime(15 * MINUTE); // 00:26: 31 min
      expect(levels(store)).toEqual(['stale-30', 'stale-30']);
      vi.advanceTimersByTime(30 * MINUTE); // 00:56: 61 min
      expect(levels(store)).toEqual(['stale-60', 'stale-60']);
    });

    it('recovers when a new reading arrives', () => {
      const { store, sse } = setup();
      vi.advanceTimersByTime(HOUR); // 01:00: both 65 min old

      sse.push(reading({ timestamp: '2026-01-03T01:00:00.000Z' }));

      expect(levels(store)).toEqual(['ok', 'stale-60']);
      expect(store.fleet().reporting).toBe(1);
    });

    it('treats a reading dated ahead of the client clock as reporting', () => {
      const { store, sse } = setup();
      sse.push(reading({ timestamp: '2026-01-03T00:10:00.000Z' })); // 10 min in the future

      expect(levels(store)[0]).toBe('ok');
    });

    it('counts only reporting turbines in the farm and fleet totals', () => {
      const { store, sse } = setup();
      vi.advanceTimersByTime(20 * MINUTE); // 00:20: both 25 min old
      sse.push(
        reading({ turbineId: 'TURB002', farmId: 'FARM02', timestamp: '2026-01-03T00:20:00.000Z' }),
      );

      expect(levels(store)).toEqual(['stale-15', 'ok']);
      expect(store.fleet()).toMatchObject({ reporting: 1, powerKw: 2000 });
      expect(store.farms()[0]).toMatchObject({
        reporting: 0,
        powerKw: 0,
        avgWindMs: null,
        staleness: 'stale-15',
      });
      expect(store.farms()[1]).toMatchObject({ reporting: 1, staleness: 'ok' });
    });

    it("gives a farm its freshest turbine's level, or empty if none ever reported", () => {
      const turbine = (id: string, timestamp: string | null) => ({
        id,
        farmId: 'FARM01',
        latitude: 0,
        longitude: 0,
        commissioned: true,
        latest: timestamp ? reading({ id: `${id}-latest`, turbineId: id, timestamp }) : null,
      });
      const { store } = setup([
        {
          id: 'FARM01',
          name: 'Mixed',
          latitude: 0,
          longitude: 0,
          turbines: [
            turbine('T60', '2026-01-02T22:00:00.000Z'), // 2 h old
            turbine('T30', '2026-01-02T23:25:00.000Z'), // 35 min old
            turbine('NEVER', null),
          ],
        },
        {
          id: 'FARM02',
          name: 'Silent',
          latitude: 0,
          longitude: 0,
          turbines: [turbine('NEVER2', null)],
        },
      ]);

      expect(levels(store)).toEqual(['stale-60', 'stale-30', 'empty', 'empty']);
      expect(store.farms().map((f) => [f.staleness, f.reporting])).toEqual([
        ['stale-30', 0],
        ['empty', 0],
      ]);
    });
  });

  it('loads history for the selected turbine and merges live readings into it in time order', () => {
    const { store, api, sse } = setup();
    api.telemetry.mockReturnValue(
      of([
        reading({ id: 'b', timestamp: '2026-01-02T23:55:00.000Z' }),
        reading({ id: 'a', timestamp: '2026-01-02T23:50:00.000Z' }),
      ]),
    );

    store.select('TURB001');
    sse.push(reading({ id: 'c', timestamp: '2026-01-03T00:00:00.000Z' }));
    sse.push(reading({ id: 'late', timestamp: '2026-01-02T23:45:00.000Z' })); // late, older
    sse.push(reading({ id: 'other', turbineId: 'TURB002', farmId: 'FARM02' })); // other turbine

    expect(store.history().map((r) => r.id)).toEqual(['c', 'b', 'a', 'late']);
    expect(store.selectedTurbine()?.id).toBe('TURB001');
  });

  it('reports a failed history load for the selected turbine and stops loading', () => {
    const { store, api } = setup();
    api.telemetry.mockReturnValue(throwError(() => new Error('down')));

    store.select('TURB001');

    expect(store.error()).toBe('Could not load telemetry for TURB001.');
    expect(store.historyLoading()).toBe(false);
    expect(store.history()).toEqual([]);
  });

  describe('history window (ends at the client clock)', () => {
    const at = (iso: string) => Date.parse(iso);

    it('requests the range ending now, open-ended so a reading at the current boundary counts', () => {
      const { store, api } = setup();

      store.select('TURB001');

      expect(api.telemetry).toHaveBeenCalledWith('TURB001', {
        from: new Date(NOW - 24 * HOUR).toISOString(),
        limit: 289,
      });
      expect(store.historyWindow()).toEqual({ from: NOW - 24 * HOUR, to: NOW });
    });

    it('ends at the clock even when the turbine’s latest reading is days old', () => {
      vi.setSystemTime(at('2026-10-06T12:00:00.000Z'));
      const { store, api } = setup();

      store.select('TURB001', 6 * HOUR);

      const end = at('2026-10-06T12:00:00.000Z');
      expect(store.historyWindow()).toEqual({ from: end - 6 * HOUR, to: end });
      expect(api.telemetry).toHaveBeenCalledWith(
        'TURB001',
        expect.objectContaining({ from: new Date(end - 6 * HOUR).toISOString() }),
      );
    });

    it('uses the injected clock', () => {
      const { api, sse } = fakes();
      TestBed.configureTestingModule({
        providers: [
          FleetStore,
          { provide: FleetApi, useValue: api },
          { provide: SseService, useValue: sse },
          { provide: AuthStore, useValue: fakeAuth() },
          { provide: NOW_TOKEN, useValue: () => at('2030-01-01T00:00:00.000Z') },
        ],
      });
      const store = TestBed.inject(FleetStore);
      store.init();

      store.select('TURB001');

      expect(store.historyWindow()?.to).toBe(at('2030-01-01T00:00:00.000Z'));
    });

    it('caps a 7-day request at the API limit of 2016 readings', () => {
      const { store, api } = setup();

      store.select('TURB001', 7 * 24 * HOUR);

      expect(api.telemetry).toHaveBeenLastCalledWith(
        'TURB001',
        expect.objectContaining({ limit: 2016 }),
      );
      expect(store.historyRangeMs()).toBe(7 * 24 * HOUR);
    });

    it('keeps the previous readings on screen while a new range loads (no empty flash)', () => {
      const { store, api } = setup();
      const pending = new Subject<ReturnType<typeof reading>[]>();
      api.telemetry.mockReturnValueOnce(of([reading({ id: 'old' })]));
      store.select('TURB001');

      api.telemetry.mockReturnValueOnce(pending);
      store.select('TURB001', 6 * HOUR);

      expect(store.history().map((r) => r.id)).toEqual(['old']);
      expect(store.historyLoading()).toBe(true);
      pending.next([reading({ id: 'new' })]);
      expect(store.history().map((r) => r.id)).toEqual(['new']);
      expect(store.historyLoading()).toBe(false);
    });

    it('keeps a live reading that arrives while the history is loading', () => {
      const { store, api, sse } = setup();
      const pending = new Subject<ReturnType<typeof reading>[]>();
      api.telemetry.mockReturnValueOnce(pending);
      store.select('TURB001');

      sse.push(reading({ id: 'live', timestamp: '2026-01-03T00:00:00.000Z' }));
      pending.next([reading({ id: 'loaded', timestamp: '2026-01-02T23:55:00.000Z' })]);

      expect(store.history().map((r) => r.id)).toEqual(['live', 'loaded']);
    });

    it('starts empty when switching to another turbine', () => {
      const { store, api } = setup();
      api.telemetry.mockReturnValueOnce(of([reading({ id: 'old' })]));
      store.select('TURB001');

      api.telemetry.mockReturnValueOnce(new Subject());
      store.select('TURB002');

      expect(store.history()).toEqual([]);
    });

    it('slides with the clock every minute, without new readings or refetching history', () => {
      const { store, api } = setup();
      store.select('TURB001');

      vi.advanceTimersByTime(MINUTE);
      expect(store.historyWindow()).toEqual({
        from: NOW + MINUTE - 24 * HOUR,
        to: NOW + MINUTE,
      });
      vi.advanceTimersByTime(59 * MINUTE);
      expect(store.historyWindow()?.to).toBe(NOW + HOUR);
      expect(api.telemetry).toHaveBeenCalledTimes(1);
    });

    it('ticks on minute boundaries, even when selected mid-minute', () => {
      vi.setSystemTime(NOW + 25_000); // 00:00:25
      const { store } = setup();
      store.select('TURB001');

      vi.advanceTimersByTime(34_999);
      expect(store.now()).toBe(NOW + 25_000);
      vi.advanceTimersByTime(1);
      expect(store.now()).toBe(NOW + MINUTE);
    });

    it('drops readings that fall out of the window as the clock moves on', () => {
      const { store, api } = setup();
      api.telemetry.mockReturnValue(
        of([
          reading({ id: 'new', timestamp: '2026-01-02T23:55:00.000Z' }),
          reading({ id: 'edge', timestamp: '2026-01-02T18:05:00.000Z' }),
          reading({ id: 'old', timestamp: '2026-01-02T18:00:00.000Z' }),
        ]),
      );
      store.select('TURB001', 6 * HOUR); // [18:00, 00:00]

      expect(store.history().map((r) => r.id)).toEqual(['new', 'edge', 'old']);
      vi.advanceTimersByTime(MINUTE); // [18:01, 00:01]
      expect(store.history().map((r) => r.id)).toEqual(['new', 'edge']);
      vi.advanceTimersByTime(5 * MINUTE); // [18:06, 00:06]
      expect(store.history().map((r) => r.id)).toEqual(['new']);
    });

    it('adds a live reading at the current 5-minute boundary at the right edge', () => {
      const { store, sse } = setup();
      store.select('TURB001');
      vi.advanceTimersByTime(5 * MINUTE + 3_000); // 00:05:03, between ticks

      sse.push(reading({ id: 'live', timestamp: '2026-01-03T00:05:00.000Z' }));

      expect(store.history()[0].id).toBe('live');
      expect(store.historyWindow()?.to).toBe(NOW + 5 * MINUTE + 3_000); // re-read on arrival
    });

    it('does not add a late reading older than the window', () => {
      const { store, sse } = setup();
      store.select('TURB001', 6 * HOUR); // [18:00, 00:00]

      sse.push(reading({ id: 'too-late', timestamp: '2026-01-02T17:55:00.000Z' }));
      sse.push(reading({ id: 'late-in', timestamp: '2026-01-02T18:00:00.000Z' }));

      expect(store.history().map((r) => r.id)).toEqual(['late-in']);
    });

    it('keeps one fleet-wide ticker from init until the store is destroyed', () => {
      const { store } = setup();
      expect(vi.getTimerCount()).toBe(1); // ticks without a selection (staleness)

      store.select('TURB001');
      store.select('TURB002'); // one ticker, however often the selection changes
      store.select(null);
      expect(vi.getTimerCount()).toBe(1);
      expect(store.historyWindow()).toBeNull();

      TestBed.resetTestingModule();
      expect(vi.getTimerCount()).toBe(0);
    });

    it('ticks on the minute boundary even when started mid-minute', () => {
      vi.setSystemTime(NOW + 20_000); // 00:00:20
      const { store } = setup();
      expect(store.now()).toBe(NOW + 20_000);

      vi.advanceTimersByTime(39_999);
      expect(store.now()).toBe(NOW + 20_000);
      vi.advanceTimersByTime(1);
      expect(store.now()).toBe(NOW + MINUTE);
    });
  });

  describe('stats', () => {
    const LATEST = Date.parse('2026-01-02T23:55:00.000Z');

    it('loads the stats for exactly the history request (same from/to/limit)', () => {
      const { store, api } = setup();
      const stats = statsFixture();
      api.telemetryStats.mockReturnValue(of(stats));

      store.select('TURB001');

      const window = { from: new Date(NOW - 24 * HOUR).toISOString(), limit: 289 };
      expect(api.telemetryStats).toHaveBeenCalledWith('TURB001', window);
      expect(api.telemetry).toHaveBeenCalledWith('TURB001', window);
      expect(store.stats()).toEqual(stats);
    });

    it('reloads on a range change, keeping the old stats until the new ones arrive', () => {
      const { store, api } = setup();
      const pending = new Subject<TelemetryStats>();
      api.telemetryStats.mockReturnValueOnce(of(statsFixture({ count: 289 })));
      store.select('TURB001');

      api.telemetryStats.mockReturnValueOnce(pending);
      store.select('TURB001', 7 * 24 * HOUR);

      expect(api.telemetryStats).toHaveBeenLastCalledWith(
        'TURB001',
        expect.objectContaining({
          from: new Date(NOW - 7 * 24 * HOUR).toISOString(),
          limit: 2016,
        }),
      );
      expect(store.stats()?.count).toBe(289);
      pending.next(statsFixture({ count: 2016 }));
      expect(store.stats()?.count).toBe(2016);
    });

    it('never shows another turbine’s stats', () => {
      const { store, api } = setup();
      api.telemetryStats.mockReturnValueOnce(of(statsFixture()));
      store.select('TURB001');

      api.telemetryStats.mockReturnValueOnce(new Subject());
      store.select('TURB002');

      expect(store.stats()).toBeNull();
    });

    it('ignores a slower, older response (the newest request wins)', () => {
      const { store, api } = setup();
      const first = new Subject<TelemetryStats>();
      const second = new Subject<TelemetryStats>();
      api.telemetryStats.mockReturnValueOnce(first).mockReturnValueOnce(second);

      store.select('TURB001', 6 * HOUR);
      store.select('TURB001', 48 * HOUR);
      second.next(statsFixture({ count: 577 }));
      first.next(statsFixture({ count: 73 })); // arrives late: must not win

      expect(first.observed).toBe(false); // cancelled
      expect(store.stats()?.count).toBe(577);
    });

    it('reloads for the slid window when a live reading for the selected turbine arrives', () => {
      const { store, api, sse } = setup();
      store.select('TURB001');
      api.telemetryStats.mockClear();
      api.telemetryStats.mockReturnValue(of(statsFixture({ count: 290 })));

      sse.push(reading({ turbineId: 'TURB002', farmId: 'FARM02' })); // other turbine: no reload
      expect(api.telemetryStats).not.toHaveBeenCalled();

      vi.setSystemTime(NOW + 5 * MINUTE + 2_000); // the reading arrives just after 00:05
      sse.push(reading({ timestamp: '2026-01-03T00:05:00.000Z' }));
      expect(api.telemetryStats).toHaveBeenCalledExactlyOnceWith('TURB001', {
        from: new Date(NOW + 5 * MINUTE + 2_000 - 24 * HOUR).toISOString(),
        limit: 289,
      });
      expect(store.stats()?.count).toBe(290);
    });

    it('does not reload for a late reading older than the window', () => {
      const { store, api, sse } = setup();
      store.select('TURB001', 6 * HOUR);
      api.telemetryStats.mockClear();

      sse.push(reading({ timestamp: '2026-01-02T17:00:00.000Z' }));

      expect(api.telemetryStats).not.toHaveBeenCalled();
    });

    it('reloads when the clock moves a reading out of the window, not on every tick', () => {
      const { store, api } = setup();
      api.telemetry.mockReturnValue(
        of([
          reading({ id: 'new', timestamp: new Date(LATEST).toISOString() }),
          reading({ id: 'old', timestamp: '2026-01-02T18:00:00.000Z' }),
        ]),
      );
      store.select('TURB001', 6 * HOUR); // [18:00, 00:00]
      api.telemetryStats.mockClear();
      const pending = new Subject<TelemetryStats>();
      api.telemetryStats.mockReturnValueOnce(pending);

      vi.advanceTimersByTime(MINUTE); // 18:00 leaves the window
      expect(api.telemetryStats).toHaveBeenCalledExactlyOnceWith('TURB001', {
        from: new Date(NOW + MINUTE - 6 * HOUR).toISOString(),
        limit: 73,
      });

      vi.advanceTimersByTime(30 * MINUTE); // 30 ticks, nothing else enters or leaves
      expect(api.telemetryStats).toHaveBeenCalledTimes(1);
      expect(pending.observed).toBe(true); // still the one pending request (switchMap)
    });

    it('does not poll the stats of an empty window', () => {
      const { store, api } = setup();
      store.select('TURB001'); // fakes(): no readings
      api.telemetryStats.mockClear();

      vi.advanceTimersByTime(HOUR);

      expect(api.telemetryStats).not.toHaveBeenCalled();
    });

    it('a failed stats request leaves no stats but never breaks the history', () => {
      const { store, api } = setup();
      api.telemetry.mockReturnValue(of([reading({ id: 'a' })]));
      api.telemetryStats.mockReturnValue(throwError(() => new Error('500')));

      store.select('TURB001');

      expect(store.stats()).toBeNull();
      expect(store.history().map((r) => r.id)).toEqual(['a']);
      expect(store.error()).toBeNull();

      // …and later requests still work (the stream survived the error).
      api.telemetryStats.mockReturnValue(of(statsFixture()));
      store.select('TURB001', 6 * HOUR);
      expect(store.stats()).not.toBeNull();
    });

    it('clears and cancels the stats when the selection is cleared', () => {
      const { store, api } = setup();
      const pending = new Subject<TelemetryStats>();
      api.telemetryStats.mockReturnValue(pending);
      store.select('TURB001');

      store.select(null);

      expect(pending.observed).toBe(false);
      expect(store.stats()).toBeNull();
    });
  });

  it('clears the selection', () => {
    const { store } = setup();
    store.select('TURB001');
    store.select(null);

    expect(store.selectedTurbine()).toBeNull();
    expect(store.history()).toEqual([]);
  });

  it('tracks the live connection status', () => {
    const { store, sse } = setup();

    sse.status('open');
    expect(store.liveStatus()).toBe('open');
    sse.status('reconnecting'); // the browser's own reconnect
    expect(store.liveStatus()).toBe('reconnecting');
    sse.status('open');
    sse.fail(); // CLOSED: the store retries (see 'live connection retry')
    expect(store.liveStatus()).toBe('reconnecting');
    vi.advanceTimersByTime(1_000);
    expect(sse.connect).toHaveBeenCalledTimes(2);
  });

  describe('live connection retry (real SseService, fake EventSource)', () => {
    const SECOND = 1_000;
    let auth: ReturnType<typeof fakeAuth>;

    beforeEach(() => {
      FakeEventSource.instances = [];
      vi.stubGlobal('EventSource', FakeEventSource);
      vi.spyOn(Math, 'random').mockReturnValue(0); // no jitter: exactly 1 s, 2 s, 4 s …
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      vi.restoreAllMocks();
    });

    function setupLive() {
      const { api } = fakes();
      auth = fakeAuth();
      TestBed.configureTestingModule({
        providers: [
          FleetStore,
          { provide: FleetApi, useValue: api },
          { provide: AuthStore, useValue: auth },
        ],
      });
      const store = TestBed.inject(FleetStore);
      store.init();
      const sources = FakeEventSource.instances;
      return { store, api, sources, last: () => sources.at(-1)! };
    }

    it('reconnects with a new EventSource after the backoff once the browser gave up', () => {
      const { store, sources, last } = setupLive();
      last().open();
      expect(store.liveStatus()).toBe('open');

      last().fail(); // e.g. a 503 while the browser reconnected during a deploy
      expect(store.liveStatus()).toBe('reconnecting');
      expect(sources[0].close).toHaveBeenCalled();
      expect(sources).toHaveLength(1);

      vi.advanceTimersByTime(SECOND);
      expect(sources).toHaveLength(2);
      expect(last().url).toBe('http://api/events');
      expect(store.liveStatus()).toBe('reconnecting'); // not "Connecting…" again
      last().open();
      expect(store.liveStatus()).toBe('open');
    });

    it('re-reads the events URL on every attempt (the token may have changed)', () => {
      const { api, sources, last } = setupLive();
      last().fail();
      api.eventsUrl = 'http://api/events?access_token=new';

      vi.advanceTimersByTime(SECOND);
      expect(sources[1].url).toBe('http://api/events?access_token=new');
    });

    it('backs off 1 s, 2 s, 4 s … and starts over after a successful open', () => {
      const { sources, last } = setupLive();
      const failAndWait = (ms: number) => {
        const before = sources.length;
        last().fail();
        vi.advanceTimersByTime(ms - 1);
        expect(sources).toHaveLength(before);
        vi.advanceTimersByTime(1);
        expect(sources).toHaveLength(before + 1);
      };

      failAndWait(SECOND); // the first connection never opened (e.g. a cold start)
      failAndWait(2 * SECOND);
      failAndWait(4 * SECOND);
      last().open();
      failAndWait(SECOND);
    });

    it('caps the backoff at 30 s and jitters it down by at most half', () => {
      expect([0, 1, 2, 3, 4, 5, 6, 20].map((n) => reconnectDelayMs(n, 0))).toEqual([
        1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000,
      ]);
      expect(reconnectDelayMs(2, 0.5)).toBe(3_000);
      expect(reconnectDelayMs(10, 0.999)).toBeGreaterThan(15_000);
    });

    it('resyncs after its own reconnect: latest readings, the selected history and the rules', () => {
      const { store, api, last } = setupLive();
      store.select('TURB001');
      last().open();
      expect(api.farms).toHaveBeenCalledTimes(1);
      expect(api.telemetry).toHaveBeenCalledTimes(1);

      last().fail();
      vi.advanceTimersByTime(SECOND);
      const farms = new Subject<FarmOverview[]>();
      api.farms.mockReturnValue(farms);
      last().open();

      expect(api.farms).toHaveBeenCalledTimes(2);
      expect(api.telemetry).toHaveBeenCalledTimes(2);
      expect(api.telemetry).toHaveBeenLastCalledWith('TURB001', expect.anything());
      expect(store.alertConfigVersion()).toBe(1);
      expect(store.unallocatedVersion()).toBe(1); // missed unallocated-turbine.changed
      expect(store.loading()).toBe(false); // no loading screen for a resync

      // A live reading newer than the resync's response is not replaced by it.
      last().emit(
        'telemetry.received',
        reading({ timestamp: '2026-01-03T00:05:00.000Z', powerOutputKw: 3000 }),
      );
      const fixture = farmsFixture();
      fixture[0].turbines[0].latest = reading({
        timestamp: '2026-01-03T00:00:00.000Z',
        powerOutputKw: 2500,
      });
      farms.next(fixture);
      farms.complete();
      expect(store.turbines()[0].latest?.powerOutputKw).toBe(3000);
      expect(store.loading()).toBe(false);
      expect(store.error()).toBeNull();
    });

    it('applies readings missed during the outage', () => {
      const { store, api, last } = setupLive();
      last().open();
      last().fail();
      vi.advanceTimersByTime(SECOND);
      const fixture = farmsFixture();
      fixture[0].turbines[0].latest = reading({
        timestamp: '2026-01-03T00:00:00.000Z',
        powerOutputKw: 2500,
      });
      api.farms.mockReturnValue(of(fixture));
      last().open();

      expect(store.turbines()[0].latest?.powerOutputKw).toBe(2500);
      expect(api.telemetry).not.toHaveBeenCalled(); // nothing selected
    });

    it('keeps the fleet and shows no error when a resync fails', () => {
      const { store, api, last } = setupLive();
      last().fail();
      vi.advanceTimersByTime(SECOND);
      api.farms.mockReturnValue(throwError(() => new Error('down')));
      last().open();

      expect(store.turbines()).toHaveLength(2);
      expect(store.error()).toBeNull();
      expect(store.liveStatus()).toBe('open');
    });

    it('loads the fleet on a reconnect after the first load failed, clearing its error', () => {
      const { api } = fakes();
      api.farms.mockReturnValueOnce(throwError(() => new Error('down')));
      TestBed.configureTestingModule({
        providers: [
          FleetStore,
          { provide: FleetApi, useValue: api },
          { provide: AuthStore, useValue: fakeAuth() },
        ],
      });
      const store = TestBed.inject(FleetStore);
      store.init();
      expect(store.error()).toBe('Could not load the fleet.');

      FakeEventSource.instances[0].fail();
      vi.advanceTimersByTime(SECOND);
      FakeEventSource.instances[1].open();

      expect(store.error()).toBeNull();
      expect(store.turbines()).toHaveLength(2);
    });

    it('does not resync after the browser’s own reconnect (it sends Last-Event-ID)', () => {
      const { store, api, sources, last } = setupLive();
      last().open();
      last().drop(); // readyState CONNECTING: the browser retries by itself
      expect(store.liveStatus()).toBe('reconnecting');
      last().open();

      expect(store.liveStatus()).toBe('open');
      expect(sources).toHaveLength(1);
      expect(api.farms).toHaveBeenCalledTimes(1);
      expect(store.alertConfigVersion()).toBe(0);
    });

    it('resyncs once per reconnect, not again on a later browser reconnect', () => {
      const { api, last } = setupLive();
      last().fail();
      vi.advanceTimersByTime(SECOND);
      last().open();
      last().drop();
      last().open();

      expect(api.farms).toHaveBeenCalledTimes(2);
    });

    it('stops retrying once signed out (offline)', () => {
      const { store, sources, last } = setupLive();
      last().open();
      auth.isAuthenticated.set(false);
      last().fail();

      expect(store.liveStatus()).toBe('offline');
      vi.advanceTimersByTime(60 * SECOND);
      expect(sources).toHaveLength(1);
    });

    it('does not reconnect when the session ends during the backoff', () => {
      const { store, sources, last } = setupLive();
      last().fail();
      expect(store.liveStatus()).toBe('reconnecting');
      auth.isAuthenticated.set(false);

      vi.advanceTimersByTime(60 * SECOND);
      expect(sources).toHaveLength(1);
      expect(store.liveStatus()).toBe('offline');
    });

    it('cancels a pending retry when the store is destroyed', () => {
      const { sources, last } = setupLive();
      last().fail();

      TestBed.resetTestingModule(); // destroys the store (the shell is gone)
      vi.advanceTimersByTime(60 * SECOND);
      expect(sources).toHaveLength(1);
    });

    it('leaves no timers behind when destroyed during the backoff', () => {
      const { last } = setupLive();
      last().fail();
      expect(vi.getTimerCount()).toBeGreaterThan(0); // the backoff and the minute tick

      TestBed.resetTestingModule();

      expect(vi.getTimerCount()).toBe(0);
    });

    it('closes the open EventSource when destroyed, and opens no other', () => {
      const { sources, last } = setupLive();
      last().open();

      TestBed.resetTestingModule();
      vi.advanceTimersByTime(60 * SECOND);

      expect(sources[0].close).toHaveBeenCalled();
      expect(sources).toHaveLength(1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('stays live after a malformed event and applies the next reading', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); // SseService warns
      onTestFinished(() => warn.mockRestore());
      const { store, sources, last } = setupLive();
      last().open();

      last().emitRaw('telemetry.received', '{"turbineId": "TURB001", ');
      last().emit(
        'telemetry.received',
        reading({ timestamp: '2026-01-03T00:00:00.000Z', powerOutputKw: 3000 }),
      );

      expect(store.liveStatus()).toBe('open');
      expect(store.turbines()[0].latest?.powerOutputKw).toBe(3000);
      expect(sources).toHaveLength(1);
    });

    describe('with the real FleetApi (token in the events URL, resync over HTTP)', () => {
      const BASE = 'http://api.test/api';
      let http: HttpTestingController;
      let session: {
        isAuthenticated: WritableSignal<boolean>;
        accessToken: WritableSignal<string>;
      };

      function setupWithApi() {
        session = { isAuthenticated: signal(true), accessToken: signal('token-1') };
        TestBed.configureTestingModule({
          providers: [
            FleetStore,
            provideHttpClient(),
            provideHttpClientTesting(),
            { provide: API_BASE_URL, useValue: BASE },
            { provide: AuthStore, useValue: session },
          ],
        });
        http = TestBed.inject(HttpTestingController);
        const store = TestBed.inject(FleetStore);
        store.init();
        http.expectOne(`${BASE}/farms`).flush(farmsFixture());
        return { store, sources: FakeEventSource.instances };
      }
      afterEach(() => http.verify());

      it('reconnects after exactly 1 s with the current token and resyncs farms, history and stats', () => {
        const { store, sources } = setupWithApi();
        expect(sources[0].url).toBe(`${BASE}/events?access_token=token-1`);
        store.select('TURB001');
        http.expectOne((r) => r.url === `${BASE}/turbines/TURB001/telemetry`).flush([]);
        http
          .expectOne((r) => r.url === `${BASE}/turbines/TURB001/telemetry/stats`)
          .flush(statsFixture());
        sources[0].open();

        sources[0].fail(); // e.g. a 401: the old token expired
        session.accessToken.set('token/2+'); // signed in again meanwhile
        vi.advanceTimersByTime(SECOND - 1);
        expect(sources).toHaveLength(1);
        vi.advanceTimersByTime(1);

        expect(sources).toHaveLength(2);
        expect(sources[1].url).toBe(`${BASE}/events?access_token=token%2F2%2B`);
        expect(store.liveStatus()).toBe('reconnecting');
        http.expectNone(`${BASE}/farms`); // nothing reloads before the new stream is open

        sources[1].open();

        http.expectOne(`${BASE}/farms`).flush(farmsFixture());
        const telemetry = http.expectOne((r) => r.url === `${BASE}/turbines/TURB001/telemetry`);
        const stats = http.expectOne((r) => r.url === `${BASE}/turbines/TURB001/telemetry/stats`);
        expect(stats.request.params.toString()).toBe(telemetry.request.params.toString());
        telemetry.flush([]);
        stats.flush(statsFixture());
        expect(store.alertConfigVersion()).toBe(1); // the rules pages reload
        expect(store.liveStatus()).toBe('open');
      });
    });
  });

  it('reports a failed fleet load', () => {
    const { api, sse } = fakes();
    api.farms.mockReturnValue(throwError(() => new Error('down')));
    TestBed.configureTestingModule({
      providers: [
        FleetStore,
        { provide: FleetApi, useValue: api },
        { provide: SseService, useValue: sse },
        { provide: AuthStore, useValue: fakeAuth() },
      ],
    });
    const store = TestBed.inject(FleetStore);
    store.init();

    expect(store.loading()).toBe(false);
    expect(store.error()).toBe('Could not load the fleet.');
  });
});
