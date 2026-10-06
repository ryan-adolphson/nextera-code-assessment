import { TestBed } from '@angular/core/testing';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { Observable, Subject, of } from 'rxjs';
import { routes } from '../app.routes';
import { NOW } from '../core/clock';
import { SseEvent, SseService } from '../core/sse.service';
import { FleetApi } from './fleet-api.service';
import { FarmOverview, MetricStats, Telemetry, TelemetryStats } from './fleet.model';

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
 */
export const mixedFleetFixture = (): FarmOverview[] => {
  const turbine = (
    id: string,
    farmId: string,
    latest: Partial<Telemetry> | null,
  ): FarmOverview['turbines'][number] => ({
    id,
    farmId,
    latitude: 40,
    longitude: -100,
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
        turbine('TURB004', 'FARM02', null), // never reported
        turbine('TURB006', 'FARM02', {
          timestamp: '2026-01-02T23:20:00.000Z', // 40 min: stale-30
          powerOutputKw: 300,
          windSpeedMs: 4,
          gearboxTempC: 126.5,
        }),
        turbine('TURB007', 'FARM02', {
          timestamp: '2026-01-02T21:30:00.000Z', // 2 h 30 min: stale-60
          powerOutputKw: 1000,
          windSpeedMs: 5,
          gearboxTempC: 70,
        }),
      ],
    },
    { id: 'FARM03', name: 'Red Canyon', latitude: 35.12, longitude: -106.55, turbines: [] },
  ];
};

/** Test doubles for FleetApi and SseService: push SSE events with `sse.push(...)`. */
export function fakes(farms: FarmOverview[] = farmsFixture()) {
  const events = new Subject<SseEvent<Telemetry>>();
  const api = {
    eventsUrl: 'http://api/events',
    farms: vi.fn((): Observable<FarmOverview[]> => of(farms)),
    telemetry: vi.fn((): Observable<Telemetry[]> => of([])),
    telemetryStats: vi.fn((): Observable<TelemetryStats> =>
      of(statsFixture({ from: null, to: null }, null)),
    ),
  };
  const sse = {
    connect: vi.fn(() => events.asObservable()),
    push: (data: Telemetry) =>
      events.next({ kind: 'message', id: '1-0', type: 'telemetry.received', data }),
    status: (status: 'connecting' | 'open' | 'reconnecting') =>
      events.next({ kind: 'status', status }),
    fail: () => events.error(new Error('closed')),
  };
  return { api, sse };
}

/**
 * Opens `url` on the real routes with fake API/SSE and the client clock `clock()`. `root` is the
 * whole rendered app (shell + page); `text` reads an element's whitespace-normalised text.
 */
export async function openFleet(url: string, clock: () => number, farms?: FarmOverview[]) {
  const { api, sse } = fakes(farms);
  TestBed.configureTestingModule({
    providers: [
      provideRouter(routes, withComponentInputBinding()),
      { provide: FleetApi, useValue: api },
      { provide: SseService, useValue: sse },
      { provide: NOW, useValue: clock },
    ],
  });
  const harness = await RouterTestingHarness.create(url);
  const root = () => harness.fixture.nativeElement as HTMLElement;
  const text = (el: Element | null | undefined) => el?.textContent?.replace(/\s+/g, ' ').trim();
  const stable = () => harness.fixture.whenStable();
  return { harness, api, sse, root, text, stable };
}
