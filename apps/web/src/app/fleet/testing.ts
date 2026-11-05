import { HttpErrorResponse, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import {
  ComponentFixture,
  DeferBlockBehavior,
  DeferBlockState,
  TestBed,
} from '@angular/core/testing';
import { InteractivityChecker } from '@angular/cdk/a11y';
import { Injectable } from '@angular/core';
import { MATERIAL_ANIMATIONS } from '@angular/material/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Observable, Subject, of, throwError } from 'rxjs';
import { AnomaliesApi } from '../alerting/anomalies-api.service';
import { AnomalyReport } from '../alerting/anomaly.model';
import { routes } from '../app.routes';
import { API_BASE_URL } from '../core/api-base-url';
import { authInterceptor } from '../core/auth/auth.interceptor';
import { SESSION_STORAGE_KEY, Session } from '../core/auth/auth.store';
import { Role } from '../core/auth/roles';
import { NOW } from '../core/clock';
import { BROWSER_TIME_ZONE, TIME_ZONE_STORAGE_PREFIX, TimeZoneMode } from '../core/time-zone';
import { SseEvent, SseService } from '../core/sse.service';
import { provideIcons } from '../ui/icons';
import { FleetApi } from './fleet-api.service';
import {
  FarmSummaryResponse,
  FleetSummaryResponse,
  MetricStats,
  Telemetry,
  TelemetryStats,
  TurbineItem,
  TurbinePageResponse,
  TurbineQuery,
  TurbineResponse,
  TurbineStatus,
} from './fleet.model';
import { WeatherApi } from '../weather/weather-api.service';
import {
  WeatherDay,
  WeatherInterval,
  WeatherQuery,
  WeatherResponse,
  WeatherSlot,
} from '../weather/weather.model';

/**
 * Evaluates the pages' `@defer` chunks (ECharts charts, Leaflet maps, Material chips) up front, so
 * a triggered block loads within its `@loading (after …)` window and renders straight from the
 * placeholder. Otherwise the first evaluation in a spec file (ECharts: ~300 ms in jsdom) would show
 * `@loading`, whose `minimum` then holds the content back on a timer `whenStable()` doesn't track.
 * The placeholder/loading/error states are tested with DeferBlockBehavior.Manual.
 */
export function preloadDeferredViews(): Promise<unknown> {
  return Promise.all([
    import('../charts/chart-group'),
    import('../map/map-view'),
    import('../alerting/alert-chips'),
  ]);
}

/**
 * `whenStable()`, a task, `whenStable()` again: a `@defer` trigger can fire after the first one
 * resolves and isn't a pending task: `on idle` is a `setTimeout` in jsdom (no requestIdleCallback),
 * `on viewport` the IntersectionObserver stub's microtask. Its loading and the render it causes are
 * pending tasks, so the second `whenStable()` covers them.
 */
export async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  await fixture.whenStable();
  await new Promise((resolve) => setTimeout(resolve));
  await fixture.whenStable();
}

/**
 * Renders every `@defer` block on the page now, as its trigger would. For specs that can't wait
 * with `settle()` because a resource request is still pending (`whenStable()` would hang until
 * it is flushed). Blocks already complete stay as they are.
 */
export async function renderDeferred(fixture: ComponentFixture<unknown>): Promise<void> {
  for (const block of await fixture.getDeferBlocks()) await block.render(DeferBlockState.Complete);
}

/** API base URL in route tests (HttpTestingController requests go here). */
export const TEST_API_BASE_URL = 'http://api.test/api';

export const reading = (overrides: Partial<Telemetry> = {}): Telemetry => ({
  id: crypto.randomUUID(),
  turbineId: 'TURB001',
  farmId: 'FARM01',
  timestamp: '2026-01-02T23:55:00.000Z',
  receivedAt: '2026-01-02T23:57:00.000Z',
  powerOutputKw: 2000,
  windSpeedMs: 7,
  rotorRpm: 12,
  bladePitchDeg: 4,
  gearboxTempC: 80,
  alerts: [],
  ...overrides,
});

/** GET /api/turbines/:id/telemetry/stats; every metric gets `metric` unless overridden. */
export const statsFixture = (
  overrides: Partial<TelemetryStats> = {},
  metric: MetricStats | null = { median: 80, high: 90, low: 70 },
): TelemetryStats => ({
  turbineId: 'TURB001',
  from: '2026-01-01T23:55:00.000Z',
  to: '2026-01-02T23:55:00.000Z',
  count: metric ? 289 : 0,
  metrics: {
    powerOutputKw: metric,
    windSpeedMs: metric,
    rotorRpm: metric,
    bladePitchDeg: metric,
    gearboxTempC: metric,
  },
  ...overrides,
});

/** A farm with its turbines and their latest readings: the fixtures the fake API derives its answers from. */
export interface FarmOverview {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  turbines: (TurbineResponse & { latest: Telemetry | null })[];
}

/** The seed dataset's fleet (trimmed to 3 farms). */
export const farmsFixture = (): FarmOverview[] => [
  {
    id: 'FARM01',
    name: 'Prairie Ridge',
    latitude: 41.25,
    longitude: -96.53,
    turbines: [
      {
        id: 'TURB001',
        farmId: 'FARM01',
        latitude: 41.263,
        longitude: -96.518,
        commissioned: true,
        latest: reading({ id: 't1-latest', powerOutputKw: 1960.5, windSpeedMs: 6.7 }),
      },
    ],
  },
  {
    id: 'FARM02',
    name: 'High Plains',
    latitude: 39.75,
    longitude: -101.22,
    turbines: [
      {
        id: 'TURB002',
        farmId: 'FARM02',
        latitude: 39.741,
        longitude: -101.207,
        commissioned: false,
        latest: reading({
          id: 't2-latest',
          turbineId: 'TURB002',
          farmId: 'FARM02',
          powerOutputKw: 2259.3,
          windSpeedMs: 8.5,
        }),
      },
    ],
  },
  { id: 'FARM03', name: 'Red Canyon', latitude: 35.12, longitude: -106.55, turbines: [] },
];

/**
 * A larger fleet for the Turbines and Alerting pages, at client time 2026-01-03T00:00Z: two
 * reporting turbines, one per stale level (two at 60 min) and one that never reported.
 * TURB004 and TURB007 are not commissioned; the others are.
 */
export const mixedFleetFixture = (): FarmOverview[] => {
  const turbine = (
    id: string,
    farmId: string,
    latest: Partial<Telemetry> | null,
    commissioned = true,
  ): FarmOverview['turbines'][number] => ({
    id,
    farmId,
    latitude: 40,
    longitude: -100,
    commissioned,
    latest: latest && reading({ id: `${id}-latest`, turbineId: id, farmId, ...latest }),
  });
  return [
    {
      id: 'FARM01',
      name: 'Prairie Ridge',
      latitude: 41.25,
      longitude: -96.53,
      turbines: [
        turbine('TURB001', 'FARM01', { powerOutputKw: 1960.5, windSpeedMs: 6.7 }),
        turbine('TURB003', 'FARM01', {
          timestamp: '2026-01-02T23:40:00.000Z', // 20 min: stale-15
          powerOutputKw: 1500,
          windSpeedMs: 9.1,
          gearboxTempC: 95,
        }),
        turbine('TURB005', 'FARM01', {
          timestamp: '2026-01-02T22:00:00.000Z', // 2 h: stale-60
          powerOutputKw: 0,
          windSpeedMs: 15.8,
          gearboxTempC: 60,
        }),
      ],
    },
    {
      id: 'FARM02',
      name: 'High Plains',
      latitude: 39.75,
      longitude: -101.22,
      turbines: [
        turbine('TURB002', 'FARM02', { powerOutputKw: 2259.3, windSpeedMs: 8.5 }),
        turbine('TURB004', 'FARM02', null, false), // never reported
        turbine('TURB006', 'FARM02', {
          timestamp: '2026-01-02T23:20:00.000Z', // 40 min: stale-30
          powerOutputKw: 300,
          windSpeedMs: 4,
          gearboxTempC: 126.5,
        }),
        turbine(
          'TURB007',
          'FARM02',
          {
            timestamp: '2026-01-02T21:30:00.000Z', // 2 h 30 min: stale-60
            powerOutputKw: 1000,
            windSpeedMs: 5,
            gearboxTempC: 70,
          },
          false,
        ),
      ],
    },
    { id: 'FARM03', name: 'Red Canyon', latitude: 35.12, longitude: -106.55, turbines: [] },
  ];
};

/** One farm of `count` reporting turbines TURB001…, for pagination (latest reading 23:55). */
export const largeFleetFixture = (count: number): FarmOverview[] => [
  {
    id: 'FARM01',
    name: 'Prairie Ridge',
    latitude: 41.25,
    longitude: -96.53,
    turbines: Array.from({ length: count }, (_, i) => {
      const id = `TURB${String(i + 1).padStart(3, '0')}`;
      return {
        id,
        farmId: 'FARM01',
        latitude: 41.25,
        longitude: -96.53,
        commissioned: true,
        latest: reading({ id: `${id}-latest`, turbineId: id, powerOutputKw: 100 + i }),
      };
    }),
  },
];

/** A 30-minute weather bucket (GET …/weather?interval=30min); every metric set unless overridden. */
export const weatherSlot = (overrides: Partial<WeatherSlot> = {}): WeatherSlot => ({
  time: '2026-01-02T23:30:00.000Z',
  samples: 2,
  windSpeed10mMs: 6,
  windSpeed80mMs: 9.4,
  windDirection10mDeg: 200,
  windDirection80mDeg: 210,
  windGusts10mMs: 12.5,
  temperature2mC: -1.5,
  relativeHumidity2mPct: 80,
  surfacePressureHpa: 990,
  precipitationMm: 0.2,
  cloudCoverPct: 75,
  ...overrides,
});

/** A daily weather row (GET …/weather?interval=daily); every metric set unless overridden. */
export const weatherDay = (overrides: Partial<WeatherDay> = {}): WeatherDay => ({
  date: '2026-01-02',
  samples: 48,
  windSpeed10mMeanMs: 5,
  windSpeed10mMaxMs: 8,
  windSpeed80mMeanMs: 8.25,
  windSpeed80mMaxMs: 13.1,
  windDirection80mDeg: 210,
  windGusts10mMaxMs: 15,
  temperature2mMinC: -4.2,
  temperature2mMaxC: 3.6,
  temperature2mMeanC: 0,
  relativeHumidity2mMeanPct: 80,
  surfacePressureMeanHpa: 990,
  precipitationSumMm: 1.4,
  cloudCoverMeanPct: 60,
  ...overrides,
});

/** A weather response for `query` (the request echoed, as the API does) with `points`. */
export const weatherResponse = <I extends WeatherInterval>(
  farmId: string,
  query: WeatherQuery<I>,
  points: WeatherResponse<I>['points'] = [],
): WeatherResponse<I> => ({
  farmId,
  from: query.from,
  to: query.to,
  interval: query.interval,
  timeZone: query.timeZone ?? 'UTC',
  points,
});

export type FakeFleetApi = ReturnType<typeof fakes>['api'];
export type FakeWeatherApi = ReturnType<typeof fakes>['weather'];
export type FakeAnomaliesApi = ReturnType<typeof fakes>['anomalies'];
export type FakeSse = ReturnType<typeof fakes>['sse'];

/** CDK's interactivity checks without layout: every element counts as visible (jsdom). */
@Injectable()
class LayoutlessInteractivityChecker extends InteractivityChecker {
  override isVisible(): boolean {
    return true;
  }
}

const STALE_AFTER_MS = 15 * 60_000;

/** The server's status for a latest reading at `now` (stale after 15 minutes). */
function serverStatus(latest: Telemetry | null, now: number): TurbineStatus {
  if (!latest) return 'no_data';
  return now - Date.parse(latest.timestamp) > STALE_AFTER_MS ? 'stale' : 'reporting';
}

/** The fake API's answers derived from `farms` at client time `now`: summaries, pages, markers. */
function fleetAnswers(farms: FarmOverview[], now: () => number) {
  const items = (): TurbineItem[] =>
    farms.flatMap((f) => f.turbines.map((t) => ({ ...t, farmName: f.name })));
  const farmSummaries = (): FarmSummaryResponse[] =>
    farms.map((f) => {
      const status = f.turbines.map((t) => serverStatus(t.latest, now()));
      const reporting = f.turbines.filter((_, i) => status[i] === 'reporting');
      const power = reporting.reduce((sum, t) => sum + t.latest!.powerOutputKw, 0);
      return {
        id: f.id,
        name: f.name,
        latitude: f.latitude,
        longitude: f.longitude,
        turbineCount: f.turbines.length,
        commissioned: f.turbines.filter((t) => t.commissioned).length,
        reporting: reporting.length,
        stale: status.filter((s) => s === 'stale').length,
        alerting: 0,
        powerOutputKw: power,
        windSpeedMs: reporting.length
          ? reporting.reduce((sum, t) => sum + t.latest!.windSpeedMs, 0) / reporting.length
          : null,
        asOf: '2026-01-02T23:55:00.000Z',
      };
    });
  const fleetSummary = (): FleetSummaryResponse => {
    const summaries = farmSummaries();
    const sum = (key: 'turbineCount' | 'commissioned' | 'reporting' | 'stale' | 'powerOutputKw') =>
      summaries.reduce((n, f) => n + f[key], 0);
    return {
      farms: summaries.length,
      turbines: sum('turbineCount'),
      commissioned: sum('commissioned'),
      reporting: sum('reporting'),
      stale: sum('stale'),
      alerting: 0,
      powerOutputKw: sum('powerOutputKw'),
      asOf: '2026-01-02T23:55:00.000Z',
    };
  };
  const page = (query: TurbineQuery): TurbinePageResponse => {
    const q = query.q?.toLowerCase();
    const value = (t: TurbineItem): string | number | null =>
      ({
        id: t.id,
        farm: t.farmName,
        commissioned: t.commissioned ? 0 : 1,
        time: t.latest?.timestamp ?? null,
        power: t.latest?.powerOutputKw ?? null,
        wind: t.latest?.windSpeedMs ?? null,
        gearbox: t.latest?.gearboxTempC ?? null,
      })[query.sort ?? 'id'];
    const dir = query.dir === 'desc' ? -1 : 1;
    const matching = items()
      .filter(
        (t) =>
          (!query.farmId || t.farmId === query.farmId) &&
          (!q || [t.id, t.farmId, t.farmName].some((s) => s.toLowerCase().includes(q))) &&
          (!query.status || serverStatus(t.latest, now()) === query.status) &&
          (query.commissioned === undefined || t.commissioned === query.commissioned) &&
          (!query.hasData || t.latest !== null),
      )
      .sort((a, b) => {
        const [x, y] = [value(a), value(b)];
        if (x === y) return a.id.localeCompare(b.id);
        if (x === null) return 1;
        if (y === null) return -1;
        return dir * (typeof x === 'number' ? x - (y as number) : x.localeCompare(y as string));
      });
    const start = query.cursor ? Number(query.cursor) : 0;
    const limit = query.limit ?? 25;
    return {
      items: matching.slice(start, start + limit),
      nextCursor: start + limit < matching.length ? String(start + limit) : null,
      prevCursor: start > 0 ? String(Math.max(0, start - limit)) : null,
      total: matching.length,
      totalCapped: false,
    };
  };
  const markers = (farmId: string) =>
    (farms.find((f) => f.id === farmId)?.turbines ?? []).map((t) => ({
      id: t.id,
      latitude: t.latitude,
      longitude: t.longitude,
      status: serverStatus(t.latest, now()),
      timestamp: t.latest?.timestamp ?? null,
    }));
  return { items, farmSummaries, fleetSummary, page, markers };
}

/**
 * Test doubles for FleetApi and SseService: push SSE events with `sse.push(...)`. The API answers
 * (summaries, turbine pages with sort/filter/cursor, markers) are derived from `farms` at `now`.
 */
export function fakes(
  farms: FarmOverview[] = farmsFixture(),
  now: () => number = () => Date.parse('2026-01-03T00:00:00.000Z'),
) {
  // One stream per connect() (like a new EventSource): after `fail()`, a retry gets a fresh one.
  let events = new Subject<SseEvent<unknown>>();
  const answers = fleetAnswers(farms, now);
  const api = {
    /** The URL each connection asked for; specs read the watched ids from `mock.calls`. */
    eventsUrl: vi.fn(
      (ids: readonly string[] = []) => `http://api/events?turbines=${ids.join(',')}`,
    ),
    fleetSummary: vi.fn(() => of(answers.fleetSummary())),
    farmSummaries: vi.fn(() => of(answers.farmSummaries())),
    turbines: vi.fn((query: TurbineQuery) => of(answers.page(query))),
    searchTurbines: vi.fn((q: string, limit = 20) =>
      of(answers.page({ q, limit, sort: 'id', dir: 'asc' }).items),
    ),
    turbine: vi.fn((id: string): Observable<TurbineItem> => {
      const found = answers.items().find((t) => t.id === id);
      return found ? of(found) : throwError(() => new HttpErrorResponse({ status: 404 }));
    }),
    turbineMarkers: vi.fn((farmId: string) => of(answers.markers(farmId))),
    telemetry: vi.fn((): Observable<Telemetry[]> => of([])),
    telemetryStats: vi.fn((): Observable<TelemetryStats> =>
      of(statsFixture({ from: null, to: null }, null)),
    ),
    /** Answers at once with the requested value; specs pass a Subject to hold the answer back. */
    setCommissioned: vi.fn((id: string, commissioned: boolean): Observable<TurbineResponse> =>
      of({ id, farmId: 'FARM01', latitude: 40, longitude: -100, commissioned }),
    ),
  };
  const sse = {
    connect: vi.fn(() => {
      if (events.hasError || events.closed) events = new Subject<SseEvent<unknown>>();
      return events.asObservable();
    }),
    push: (data: Telemetry) =>
      events.next({ kind: 'message', id: '', type: 'telemetry.received', data }),
    /** The fleet-wide `farm-rollup.completed` event. */
    farmRollup: (asOf = '2026-01-02T23:45:00.000Z') =>
      events.next({ kind: 'message', id: '4-0', type: 'farm-rollup.completed', data: { asOf } }),
    /** The fleet-wide `fleet.tick` event. */
    tick: (asOf = '2026-01-02T23:55:00.000Z') =>
      events.next({ kind: 'message', id: '3-0', type: 'fleet.tick', data: { asOf } }),
    /** Any named event, e.g. `alert-config.changed`. */
    pushEvent: (type: string, data: unknown) =>
      events.next({ kind: 'message', id: '2-0', type, data }),
    status: (status: 'connecting' | 'open' | 'reconnecting') =>
      events.next({ kind: 'status', status }),
    /** The connection is CLOSED (the store retries after its backoff with a new connect). */
    fail: () => events.error(new Error('closed')),
    /** Whether anything (FleetStore) is still subscribed to the current live stream. */
    observed: () => events.observed,
  };
  /** WeatherApi: no weather synced, unless a spec sets the mocks (or uses `weatherHttp`). */
  const weather = {
    farm: vi.fn(
      <I extends WeatherInterval>(farmId: string, query: WeatherQuery<I>) =>
        of(weatherResponse(farmId, query)) as Observable<WeatherResponse<I>>,
    ),
  };
  /** AnomaliesApi: no anomalies, unless a spec sets the mock. */
  const anomalies = {
    list: vi.fn((from: string, to: string): Observable<AnomalyReport> =>
      of({ from, to, estimatedLostKwh: 0, anomalies: [] }),
    ),
  };
  return { api, sse, weather, anomalies };
}

/** A stored session for `role`, signed in at `now` and valid for 24 h (what AuthStore keeps). */
export function testSession(role: Role, now: number): Session {
  return {
    accessToken: `test-token-${role}`,
    expiresAt: new Date(now + 24 * 3_600_000).toISOString(),
    signedInAt: new Date(now).toISOString(),
    user: { email: `${role}@nextera.local`, role },
  };
}

/** Signs `role` in for the next TestBed (AuthStore restores it); null = signed out. */
export function storeSession(session: Session | null): void {
  localStorage.removeItem(SESSION_STORAGE_KEY);
  if (session) localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
}

/** The browser zone `openFleet` pins (UTC−6 in winter, −5 in summer; DST changes 2026-03-08 and 2026-11-01). */
export const TEST_BROWSER_ZONE = 'America/Chicago';

export interface TimeZoneOptions {
  /** The signed-in user's saved setting (default UTC). */
  timeZone?: TimeZoneMode;
  /** The browser's IANA zone (`BROWSER_TIME_ZONE`). */
  browserZone?: string;
  /**
   * The real WeatherApi, so weather requests go to `http` (HttpTestingController; flush them, or
   * `whenStable()` waits). By default a fake answers at once with no weather.
   */
  weatherHttp?: boolean;
  /**
   * `@defer` blocks: Playthrough (default) renders them as the app does; Manual keeps them on
   * their placeholder until a spec renders a state (`fixture.getDeferBlocks()`). Set here, since
   * each `configureTestingModule` call resets it.
   */
  deferBlockBehavior?: DeferBlockBehavior;
}

/** Forgets every user's saved time-zone setting (localStorage outlives a test). */
export function clearTimeZoneSettings(): void {
  const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i));
  for (const key of keys) {
    if (key?.startsWith(TIME_ZONE_STORAGE_PREFIX)) localStorage.removeItem(key);
  }
}

/** Saves `role`'s test user's time-zone setting, as the Settings page would. */
export function storeTimeZone(role: Role, mode: TimeZoneMode): void {
  localStorage.setItem(`${TIME_ZONE_STORAGE_PREFIX}${role}@nextera.local`, mode);
}

/**
 * Opens `url` on the real routes with fake API/SSE and the client clock `clock()`, signed in as
 * `role` (default admin, who sees everything; null = signed out). `root` is the
 * whole rendered app (shell + page); `text` reads an element's whitespace-normalised text.
 * `beforeOpen` sets up the fakes before the first navigation (e.g. a turbine's history).
 * Weather: a fake WeatherApi with no weather (`weather`), or the real one with `weatherHttp`.
 * Times: the user's time-zone setting starts as UTC (any stored one is cleared; `timeZone: 'local'`
 * stores Local first), and the browser's zone is pinned to `browserZone` (America/Chicago).
 */
export async function openFleet(
  url: string,
  clock: () => number,
  farms?: FarmOverview[],
  beforeOpen?: (fakes: {
    api: FakeFleetApi;
    sse: FakeSse;
    weather: FakeWeatherApi;
    anomalies: FakeAnomaliesApi;
  }) => void,
  role: Role | null = 'admin',
  {
    timeZone = 'utc',
    browserZone = TEST_BROWSER_ZONE,
    weatherHttp = false,
    deferBlockBehavior = DeferBlockBehavior.Playthrough,
  }: TimeZoneOptions = {},
) {
  await preloadDeferredViews();
  const { api, sse, weather, anomalies } = fakes(farms, clock);
  clearTimeZoneSettings();
  if (role && timeZone === 'local') storeTimeZone(role, 'local');
  beforeOpen?.({ api, sse, weather, anomalies });
  storeSession(role && testSession(role, clock()));
  TestBed.configureTestingModule({
    deferBlockBehavior,
    providers: [
      provideRouter(routes, withComponentInputBinding()),
      // Pages that talk to the API through HttpClient (alert rules): flush with `http`. With the
      // app's auth interceptor (Bearer header, 401 → /login).
      provideHttpClient(withInterceptors([authInterceptor])),
      provideHttpClientTesting(),
      { provide: API_BASE_URL, useValue: TEST_API_BASE_URL },
      { provide: FleetApi, useValue: api },
      { provide: SseService, useValue: sse },
      { provide: AnomaliesApi, useValue: anomalies },
      { provide: NOW, useValue: clock },
      { provide: BROWSER_TIME_ZONE, useValue: browserZone },
      ...(weatherHttp ? [] : [{ provide: WeatherApi, useValue: weather }]),
      provideIcons(),
      // Material dialogs, chips… without animations: open/close happen synchronously in tests.
      { provide: MATERIAL_ANIMATIONS, useValue: { animationsDisabled: true } },
      // jsdom has no layout, so CDK would find nothing visible (hence nothing tabbable) and focus
      // traps (MatDialog autoFocus, cdkFocusInitial) would fall back to the container.
      { provide: InteractivityChecker, useClass: LayoutlessInteractivityChecker },
    ],
  });
  const harness = await RouterTestingHarness.create(url);
  const root = () => harness.fixture.nativeElement as HTMLElement;
  const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();
  const stable = () => settle(harness.fixture);
  const http = TestBed.inject(HttpTestingController);
  return { harness, api, sse, weather, anomalies, http, root, text, stable };
}

/**
 * Drives a Material date range picker's calendar with DOM clicks, like a user (the harness waits
 * for stability, which never comes while a load it triggers is pending). `field` is the
 * `mat-form-field` around the `mat-date-range-input`. Call `TestBed.tick()` / settle after each.
 */
export const rangeCalendar = (field: Element) => {
  const overlay = () => document.querySelector('.cdk-overlay-container mat-calendar');
  return {
    open: () => field.querySelector<HTMLButtonElement>('mat-datepicker-toggle button')!.click(),
    isOpen: () => overlay() !== null,
    previousMonth: () =>
      overlay()!.querySelector<HTMLButtonElement>('.mat-calendar-previous-button')!.click(),
    /** Clicks a day of the month shown. */
    pick: (day: number) =>
      [...overlay()!.querySelectorAll<HTMLElement>('.mat-calendar-body-cell')]
        .find((cell) => cell.textContent?.trim() === String(day))!
        .click(),
  };
};
