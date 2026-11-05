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
import {
  FarmSummaryResponse,
  FleetSummaryResponse,
  LIVE_FUTURE_TOLERANCE_MS,
  Telemetry,
  TelemetryStats,
} from './fleet.model';
import { FleetStore, reconnectDelayMs } from './fleet.store';
import { FarmOverview, fakes, farmsFixture, reading, statsFixture } from './testing';

/** The part of AuthStore the FleetStore reads: whether to keep retrying the live connection. */
const fakeAuth = (signedIn = true) => ({ isAuthenticated: signal(signedIn) });

/** The client clock in these tests: 5 minutes after TURB001's latest reading (23:55). */
const NOW = Date.parse('2026-01-03T00:00:00.000Z');
/** Owners of watched ids (a table, the selected turbine: any object). */
const [A, B, C, TABLE] = [{}, {}, {}, {}];
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

  /** The ids of the latest connection the store asked for. */
  const watched = (api: ReturnType<typeof setup>['api']) => api.eventsUrl.mock.lastCall![0] ?? [];

  describe('the live connection and its events', () => {
    it('opens the connection before loading the summaries, listening for every event type', () => {
      const { api, sse } = setup();

      expect(sse.connect).toHaveBeenCalledWith('http://api/events?turbines=', [
        'telemetry.received',
        'alert-config.changed',
        'unallocated-turbine.changed',
        'fleet.changed',
        'fleet.tick',
      ]);
      expect(sse.connect.mock.invocationCallOrder[0]).toBeLessThan(
        api.fleetSummary.mock.invocationCallOrder[0],
      );
      expect(sse.connect.mock.invocationCallOrder[0]).toBeLessThan(
        api.farmSummaries.mock.invocationCallOrder[0],
      );
    });

    it('counts alert-config.changed events on the same connection, leaving the summaries alone', () => {
      const { store, api, sse } = setup();

      sse.pushEvent('alert-config.changed', { action: 'created', id: 'r1' });
      sse.pushEvent('alert-config.changed', { action: 'deleted', id: 'r1' });

      expect(store.alertConfigVersion()).toBe(2);
      expect(api.fleetSummary).toHaveBeenCalledTimes(1);
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
      expect(api.farmSummaries).toHaveBeenCalledTimes(1);
    });

    it("counts every open, the browser's own reconnects too, so tables fetch their page again", () => {
      const { store, sse } = setup();
      expect(store.streamOpens()).toBe(0);

      sse.status('open');
      sse.status('reconnecting');
      sse.status('open');

      expect(store.streamOpens()).toBe(2);
    });
  });

  describe('summaries', () => {
    it("shows the fleet totals and each farm from the server's summaries", () => {
      const { store } = setup();

      expect(store.loading()).toBe(false);
      expect(store.fleet()).toEqual({
        farms: 3,
        turbines: 2,
        commissioned: 1,
        reporting: 2,
        stale: 0,
        alerting: 0,
        powerKw: 4219.8,
        asOf: '2026-01-02T23:55:00.000Z',
      });
      expect(store.farms()[0]).toEqual({
        id: 'FARM01',
        name: 'Prairie Ridge',
        latitude: 41.25,
        longitude: -96.53,
        turbineCount: 1,
        commissioned: 1,
        reporting: 1,
        stale: 0,
        alerting: 0,
        staleness: 'ok',
        powerKw: 1960.5,
        avgWindMs: 6.7,
        asOf: '2026-01-02T23:55:00.000Z',
      });
      expect(store.farms()[2]).toMatchObject({
        turbineCount: 0,
        powerKw: 0,
        avgWindMs: null,
        staleness: 'empty',
      });
    });

    it('is zeros and no time before the first answer', () => {
      const { api } = fakes();
      api.fleetSummary.mockReturnValue(new Subject());
      TestBed.configureTestingModule({
        providers: [
          FleetStore,
          { provide: FleetApi, useValue: api },
          { provide: SseService, useValue: fakes().sse },
          { provide: AuthStore, useValue: fakeAuth() },
        ],
      });
      const store = TestBed.inject(FleetStore);
      store.init();

      expect(store.loading()).toBe(true);
      expect(store.fleetLoadedOk()).toBe(false);
      expect(store.fleet()).toMatchObject({ farms: 0, turbines: 0, powerKw: 0, asOf: null });
      expect(store.farms()).toEqual([]);
      expect(store.fleetTime()).toBeNull();
    });

    it('dates the fleet ("data as of") by the summary, or not at all when it has none', () => {
      expect(setup().store.fleetTime()).toBe(Date.parse('2026-01-02T23:55:00.000Z'));
      TestBed.resetTestingModule();

      const { api, sse } = fakes();
      api.fleetSummary.mockReturnValue(
        of({
          farms: 0,
          turbines: 0,
          commissioned: 0,
          reporting: 0,
          stale: 0,
          alerting: 0,
          powerOutputKw: 0,
          asOf: null,
        }),
      );
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
      expect(store.fleetTime()).toBeNull();
    });

    it("gives a farm 'ok' if any turbine reports, 'stale-15' if none does but some are stale, else 'empty'", () => {
      const turbine = (id: string, timestamp: string | null) => ({
        id,
        farmId: 'FARM01',
        latitude: 0,
        longitude: 0,
        commissioned: true,
        latest: timestamp ? reading({ id: `${id}-latest`, turbineId: id, timestamp }) : null,
      });
      const farm = (id: string, turbines: ReturnType<typeof turbine>[]): FarmOverview => ({
        id,
        name: id,
        latitude: 0,
        longitude: 0,
        turbines,
      });
      const { store } = setup([
        farm('REPORTING', [turbine('T1', '2026-01-02T23:55:00.000Z'), turbine('T2', null)]),
        farm('STALE', [
          turbine('T60', '2026-01-02T22:00:00.000Z'),
          turbine('T30', '2026-01-02T23:25:00.000Z'),
        ]),
        farm('SILENT', [turbine('NEVER', null)]),
        farm('EMPTY', []),
      ]);

      expect(store.farms().map((f) => [f.id, f.staleness, f.reporting, f.stale])).toEqual([
        ['REPORTING', 'ok', 1, 0],
        ['STALE', 'stale-15', 0, 2],
        ['SILENT', 'empty', 0, 0],
        ['EMPTY', 'empty', 0, 0],
      ]);
    });

    it('reports a failed first load, and no farm is trusted as missing', () => {
      const { api, sse } = fakes();
      api.farmSummaries.mockReturnValue(throwError(() => new Error('down')));
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
      expect(store.fleetLoadedOk()).toBe(false);
      expect(store.farms()).toEqual([]);
    });

    describe('refreshing on fleet.tick', () => {
      const changed = (): { fleet: FleetSummaryResponse; farms: FarmSummaryResponse[] } => {
        const { api } = fakes(farmsFixture(), () => NOW + 30 * MINUTE); // the server's later view
        let fleet!: FleetSummaryResponse;
        let farms!: FarmSummaryResponse[];
        api.fleetSummary().subscribe((f) => (fleet = f));
        api.farmSummaries().subscribe((f) => (farms = f));
        return { fleet, farms };
      };

      it('loads both summaries again, quietly, and bumps summaryVersion', () => {
        const { store, api, sse } = setup();
        const version = store.summaryVersion();
        const later = changed();
        api.fleetSummary.mockReturnValue(of(later.fleet));
        api.farmSummaries.mockReturnValue(of(later.farms));

        sse.tick();

        expect(api.fleetSummary).toHaveBeenCalledTimes(2);
        expect(api.farmSummaries).toHaveBeenCalledTimes(2);
        expect(store.loading()).toBe(false);
        expect(store.summaryVersion()).toBe(version + 1);
        expect(store.fleet().reporting).toBe(0); // 30 min later: both quiet
        expect(store.farms()[0].staleness).toBe('stale-15');
      });

      it('keeps what is shown, without an error, when a refresh fails', () => {
        const { store, api, sse } = setup();
        api.farmSummaries.mockReturnValue(throwError(() => new Error('down')));

        sse.tick();

        expect(store.error()).toBeNull();
        expect(store.fleet().turbines).toBe(2);
        expect(store.farms()).toHaveLength(3);
      });

      it("clears the first load's error once a refresh succeeds", () => {
        const { api, sse } = fakes();
        api.fleetSummary.mockReturnValueOnce(throwError(() => new Error('down')));
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
        expect(store.error()).toBe('Could not load the fleet.');

        sse.tick();

        expect(store.error()).toBeNull();
        expect(store.fleetLoadedOk()).toBe(true);
        expect(store.farms()).toHaveLength(3);
      });

      it('replaces a refresh still in flight, so an old answer never lands', () => {
        const { api, sse } = setup();
        const slow = new Subject<FarmSummaryResponse[]>();
        api.farmSummaries.mockReturnValue(slow);
        sse.tick();
        expect(slow.observed).toBe(true);

        api.farmSummaries.mockReturnValue(of([]));
        sse.tick();

        expect(slow.observed).toBe(false);
      });
    });

    describe('fleet.changed (a turbine was assigned, moved or commissioned)', () => {
      it('bumps fleetVersion and reloads the summaries quietly', () => {
        const { store, api, sse } = setup();

        sse.pushEvent('fleet.changed', { turbineId: 'TURB990' });

        expect(store.fleetVersion()).toBe(1);
        expect(api.fleetSummary).toHaveBeenCalledTimes(2);
        expect(api.farmSummaries).toHaveBeenCalledTimes(2);
        expect(store.loading()).toBe(false);
      });

      it('does the same for a local reloadFleet()', () => {
        const { store, api } = setup();

        store.reloadFleet();

        expect(store.fleetVersion()).toBe(1);
        expect(api.farmSummaries).toHaveBeenCalledTimes(2);
      });
    });
  });

  describe("watchTurbines (which turbines' readings the connection carries)", () => {
    it('reconnects with the ids a table shows, without showing "Connecting…" again', () => {
      const { store, api, sse } = setup();
      const owner = {};
      sse.status('open');

      store.watchTurbines(owner, ['TURB001', 'TURB002']);

      expect(sse.connect).toHaveBeenCalledTimes(2);
      expect(watched(api)).toEqual(['TURB001', 'TURB002']);
      expect(store.liveStatus()).toBe('open');
    });

    it('refreshes the summaries (not a full resync) when the new connection opens', () => {
      const { store, api, sse } = setup();
      store.watchTurbines({}, ['TURB001']);
      expect(api.fleetSummary).toHaveBeenCalledTimes(1);

      sse.status('open');

      expect(api.fleetSummary).toHaveBeenCalledTimes(2);
      expect(store.alertConfigVersion()).toBe(0);
      expect(store.unallocatedVersion()).toBe(0);
    });

    it("sends the union of all owners' ids, once each, at most 100", () => {
      const { store, api } = setup();
      const ids = (from: number, n: number) => Array.from({ length: n }, (_, i) => `T${from + i}`);

      store.watchTurbines(A, ids(0, 60));
      store.watchTurbines(B, ids(30, 60)); // 30 shared

      expect(watched(api)).toHaveLength(90);
      expect(new Set(watched(api)).size).toBe(90);

      store.watchTurbines(C, ids(100, 50));
      expect(watched(api)).toHaveLength(100);
    });

    it("replaces an owner's earlier list, and stops watching when it gives none", () => {
      const { store, api } = setup();
      const owner = {};

      store.watchTurbines(owner, ['TURB001']);
      store.watchTurbines(owner, ['TURB002']);
      expect(watched(api)).toEqual(['TURB002']);

      store.watchTurbines(owner, []);
      expect(watched(api)).toEqual([]);
    });

    it('does not reconnect when the set is the same, in any order', () => {
      const { store, sse } = setup();
      store.watchTurbines(A, ['TURB001', 'TURB002']);
      const connects = sse.connect.mock.calls.length;

      store.watchTurbines(A, ['TURB002', 'TURB001']);
      store.watchTurbines(B, ['TURB001']);

      expect(sse.connect).toHaveBeenCalledTimes(connects);
    });

    it('watches the selected turbine too, and lets go when it is cleared', () => {
      const { store, api } = setup();

      store.select('TURB001');
      expect(watched(api)).toEqual(['TURB001']);

      store.watchTurbines(TABLE, ['TURB002']);
      expect([...watched(api)].sort()).toEqual(['TURB001', 'TURB002']);

      store.select(null);
      expect(watched(api)).toEqual(['TURB002']);
    });

    it('closes the old connection when it opens another', () => {
      const { store, sse } = setup();
      const before = sse.observed();
      expect(before).toBe(true);

      store.watchTurbines(A, ['TURB001']);

      expect(sse.connect).toHaveBeenCalledTimes(2);
      expect(sse.observed()).toBe(true); // exactly the new one is subscribed
    });
  });

  describe('readings$ (live readings of the watched turbines)', () => {
    it('passes each reading on to subscribers, whichever turbine it is for', () => {
      const { store, sse } = setup();
      const received: string[] = [];
      store.readings$.subscribe((r) => received.push(r.turbineId));

      sse.push(reading({ turbineId: 'TURB002', farmId: 'FARM02' }));
      sse.push(reading({ turbineId: 'TURB777', farmId: 'FARM09' }));

      expect(received).toEqual(['TURB002', 'TURB777']);
    });

    it('keeps no per-turbine state: the summaries do not move with a reading', () => {
      const { store, api, sse } = setup();
      const before = store.fleet();

      sse.push(reading({ timestamp: '2026-01-03T00:00:00.000Z', powerOutputKw: 9999 }));

      expect(store.fleet()).toEqual(before);
      expect(api.fleetSummary).toHaveBeenCalledTimes(1);
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
      ])('is passed on %s ahead', (_, ms) => {
        const { store, sse } = setup();
        const received: string[] = [];
        store.readings$.subscribe((r) => received.push(r.id));

        sse.push(ahead(ms));

        expect(received).toEqual([`ahead-${ms}`]);
        expect(warn).not.toHaveBeenCalled();
      });

      it('is ignored more than 10 min ahead (10 min 1 s), with a warning', () => {
        const { store, sse } = setup();
        const received: string[] = [];
        store.readings$.subscribe((r) => received.push(r.id));

        sse.push(ahead(10 * MINUTE + 1_000));

        expect(received).toEqual([]);
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
    expect(store.selectedTurbineId()).toBe('TURB001');
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

    expect(store.selectedTurbineId()).toBeNull();
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
      expect(last().url).toBe('http://api/events?turbines=');
      expect(store.liveStatus()).toBe('reconnecting'); // not "Connecting…" again
      last().open();
      expect(store.liveStatus()).toBe('open');
    });

    it('re-reads the events URL on every attempt (the token may have changed)', () => {
      const { api, sources, last } = setupLive();
      last().fail();
      api.eventsUrl.mockReturnValue('http://api/events?access_token=new');

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

    it('resyncs after its own reconnect: the summaries, the selected history and the rules', () => {
      const { store, api, last } = setupLive();
      store.select('TURB001');
      last().open();
      expect(api.fleetSummary).toHaveBeenCalledTimes(2); // the first load; the new watch's open
      expect(api.telemetry).toHaveBeenCalledTimes(1);

      last().fail();
      vi.advanceTimersByTime(SECOND);
      last().open();

      expect(api.fleetSummary).toHaveBeenCalledTimes(3);
      expect(api.farmSummaries).toHaveBeenCalledTimes(3);
      expect(api.telemetry).toHaveBeenCalledTimes(2);
      expect(api.telemetry).toHaveBeenLastCalledWith('TURB001', expect.anything());
      expect(api.telemetryStats).toHaveBeenCalledTimes(2);
      expect(store.alertConfigVersion()).toBe(1);
      expect(store.unallocatedVersion()).toBe(1); // missed unallocated-turbine.changed
      expect(store.loading()).toBe(false); // no loading screen for a resync
    });

    it("keeps the selected turbine's ids on the new connection after an outage", () => {
      const { store, api, last } = setupLive();
      store.select('TURB001');
      last().fail();

      vi.advanceTimersByTime(SECOND);

      expect(watched(api)).toEqual(['TURB001']);
      expect(last().url).toBe('http://api/events?turbines=TURB001');
    });

    it('tells the tables to fetch their page again on every open', () => {
      const { store, last } = setupLive();
      last().open();
      last().drop();
      last().open();
      last().fail();
      vi.advanceTimersByTime(SECOND);
      last().open();

      expect(store.streamOpens()).toBe(3);
    });

    it('shows the newer summaries a resync loads', () => {
      const { store, api, last } = setupLive();
      last().open();
      last().fail();
      vi.advanceTimersByTime(SECOND);
      api.fleetSummary.mockReturnValue(
        of({
          farms: 3,
          turbines: 2,
          commissioned: 1,
          reporting: 1,
          stale: 1,
          alerting: 0,
          powerOutputKw: 2500,
          asOf: '2026-01-03T00:00:00.000Z',
        }),
      );
      last().open();

      expect(store.fleet().reporting).toBe(1);
      expect(store.fleetTime()).toBe(Date.parse('2026-01-03T00:00:00.000Z'));
      expect(api.telemetry).not.toHaveBeenCalled(); // nothing selected
    });

    it('keeps the summaries and shows no error when a resync fails', () => {
      const { store, api, last } = setupLive();
      last().fail();
      vi.advanceTimersByTime(SECOND);
      api.farmSummaries.mockReturnValue(throwError(() => new Error('down')));
      last().open();

      expect(store.farms()).toHaveLength(3);
      expect(store.error()).toBeNull();
      expect(store.liveStatus()).toBe('open');
    });

    it('loads the summaries on a reconnect after the first load failed, clearing its error', () => {
      const { api } = fakes();
      api.fleetSummary.mockReturnValueOnce(throwError(() => new Error('down')));
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
      expect(store.farms()).toHaveLength(3);
    });

    it('does not resync after the browser’s own reconnect (it sends Last-Event-ID)', () => {
      const { store, api, sources, last } = setupLive();
      last().open();
      last().drop(); // readyState CONNECTING: the browser retries by itself
      expect(store.liveStatus()).toBe('reconnecting');
      last().open();

      expect(store.liveStatus()).toBe('open');
      expect(sources).toHaveLength(1);
      expect(api.fleetSummary).toHaveBeenCalledTimes(1);
      expect(store.alertConfigVersion()).toBe(0);
    });

    it('resyncs once per reconnect, not again on a later browser reconnect', () => {
      const { api, last } = setupLive();
      last().fail();
      vi.advanceTimersByTime(SECOND);
      last().open();
      last().drop();
      last().open();

      expect(api.fleetSummary).toHaveBeenCalledTimes(2);
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
      const received: Telemetry[] = [];
      store.readings$.subscribe((r) => received.push(r));
      last().open();

      last().emitRaw('telemetry.received', '{"turbineId": "TURB001", ');
      last().emit(
        'telemetry.received',
        reading({ timestamp: '2026-01-03T00:00:00.000Z', powerOutputKw: 3000 }),
      );

      expect(store.liveStatus()).toBe('open');
      expect(received.map((r) => r.powerOutputKw)).toEqual([3000]);
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
        flushSummaries();
        return { store, sources: FakeEventSource.instances };
      }
      afterEach(() => http.verify());

      /** Answers the pending summaries requests (GET /fleet/summary and /farm-summaries). */
      function flushSummaries() {
        const { api } = fakes();
        let fleet!: FleetSummaryResponse;
        let farms!: FarmSummaryResponse[];
        api.fleetSummary().subscribe((f) => (fleet = f));
        api.farmSummaries().subscribe((f) => (farms = f));
        http.expectOne(`${BASE}/fleet/summary`).flush(fleet);
        http.expectOne(`${BASE}/farm-summaries`).flush(farms);
      }

      it('reconnects after exactly 1 s with the current token and resyncs the summaries, history and stats', () => {
        const { store, sources } = setupWithApi();
        expect(sources[0].url).toBe(`${BASE}/events?access_token=token-1`);
        store.select('TURB001'); // reconnects with the selected turbine's readings
        http.expectOne((r) => r.url === `${BASE}/turbines/TURB001/telemetry`).flush([]);
        http
          .expectOne((r) => r.url === `${BASE}/turbines/TURB001/telemetry/stats`)
          .flush(statsFixture());
        expect(sources).toHaveLength(2);
        expect(sources[1].url).toBe(`${BASE}/events?access_token=token-1&turbines=TURB001`);
        sources[1].open();
        flushSummaries(); // the new connection's open refreshes the summaries, nothing more

        sources[1].fail(); // e.g. a 401: the old token expired
        session.accessToken.set('token/2+'); // signed in again meanwhile
        vi.advanceTimersByTime(SECOND - 1);
        expect(sources).toHaveLength(2);
        vi.advanceTimersByTime(1);

        expect(sources).toHaveLength(3);
        expect(sources[2].url).toBe(`${BASE}/events?access_token=token%2F2%2B&turbines=TURB001`);
        expect(store.liveStatus()).toBe('reconnecting');
        http.expectNone(`${BASE}/farm-summaries`); // nothing reloads before the new stream is open

        sources[2].open();

        flushSummaries();
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
});
