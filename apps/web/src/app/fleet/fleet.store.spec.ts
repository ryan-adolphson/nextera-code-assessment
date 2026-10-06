import { TestBed } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';
import { NOW as NOW_TOKEN } from '../core/clock';
import { SseService } from '../core/sse.service';
import { FleetApi } from './fleet-api.service';
import { FarmOverview, TelemetryStats } from './fleet.model';
import { FleetStore } from './fleet.store';
import { fakes, farmsFixture, reading, statsFixture } from './testing';

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
      ],
    });
    const store = TestBed.inject(FleetStore);
    store.init();
    return { store, api, sse };
  }

  it('subscribes to live readings before loading the fleet', () => {
    const { api, sse } = setup();

    expect(sse.connect).toHaveBeenCalledWith('http://api/events', ['telemetry.received']);
    expect(sse.connect.mock.invocationCallOrder[0]).toBeLessThan(
      api.farms.mock.invocationCallOrder[0],
    );
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
    expect(store.recentlyUpdated()).toBe('TURB001');
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
    expect(store.recentlyUpdated()).toBeNull();
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
    sse.fail();
    expect(store.liveStatus()).toBe('offline');
  });

  it('reports a failed fleet load', () => {
    const { api, sse } = fakes();
    api.farms.mockReturnValue(throwError(() => new Error('down')));
    TestBed.configureTestingModule({
      providers: [
        FleetStore,
        { provide: FleetApi, useValue: api },
        { provide: SseService, useValue: sse },
      ],
    });
    const store = TestBed.inject(FleetStore);
    store.init();

    expect(store.loading()).toBe(false);
    expect(store.error()).toBe('Could not load the fleet.');
  });
});
