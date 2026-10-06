import { Observable, Subject, of } from 'rxjs';
import { SseEvent } from '../core/sse.service';
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
