import { provideHttpClient, withInterceptors } from '@angular/common/http';
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
import { Observable, Subject, of } from 'rxjs';
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
import { FarmOverview, MetricStats, Telemetry, TelemetryStats } from './fleet.model';
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

/** Shape of GET /api/farms for the seed dataset (trimmed to 3 farms). */
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
  turbineId?: string,
): WeatherResponse<I> => ({
  farmId,
  ...(turbineId && { turbineId }),
  from: query.from,
  to: query.to,
  interval: query.interval,
  timeZone: query.timeZone ?? 'UTC',
  points,
});

export type FakeFleetApi = ReturnType<typeof fakes>['api'];
export type FakeWeatherApi = ReturnType<typeof fakes>['weather'];
export type FakeSse = ReturnType<typeof fakes>['sse'];

/** CDK's interactivity checks without layout: every element counts as visible (jsdom). */
@Injectable()
class LayoutlessInteractivityChecker extends InteractivityChecker {
  override isVisible(): boolean {
    return true;
  }
}

/** Test doubles for FleetApi and SseService: push SSE events with `sse.push(...)`. */
export function fakes(farms: FarmOverview[] = farmsFixture()) {
  // One stream per connect() (like a new EventSource): after `fail()`, a retry gets a fresh one.
  let events = new Subject<SseEvent<unknown>>();
  const api = {
    eventsUrl: 'http://api/events',
    farms: vi.fn((): Observable<FarmOverview[]> => of(farms)),
    telemetry: vi.fn((): Observable<Telemetry[]> => of([])),
    telemetryStats: vi.fn((): Observable<TelemetryStats> =>
      of(statsFixture({ from: null, to: null }, null)),
    ),
  };
  const sse = {
    connect: vi.fn(() => {
      if (events.hasError || events.closed) events = new Subject<SseEvent<unknown>>();
      return events.asObservable();
    }),
    push: (data: Telemetry) =>
      events.next({ kind: 'message', id: '1-0', type: 'telemetry.received', data }),
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
    turbine: vi.fn(
      <I extends WeatherInterval>(turbineId: string, query: WeatherQuery<I>) =>
        of(weatherResponse('FARM01', query, [], turbineId)) as Observable<WeatherResponse<I>>,
    ),
  };
  return { api, sse, weather };
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
  beforeOpen?: (fakes: { api: FakeFleetApi; sse: FakeSse; weather: FakeWeatherApi }) => void,
  role: Role | null = 'admin',
  {
    timeZone = 'utc',
    browserZone = TEST_BROWSER_ZONE,
    weatherHttp = false,
    deferBlockBehavior = DeferBlockBehavior.Playthrough,
  }: TimeZoneOptions = {},
) {
  await preloadDeferredViews();
  const { api, sse, weather } = fakes(farms);
  clearTimeZoneSettings();
  if (role && timeZone === 'local') storeTimeZone(role, 'local');
  beforeOpen?.({ api, sse, weather });
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
  return { harness, api, sse, weather, http, root, text, stable };
}
