import { expect, type APIRequestContext, type Page, type Response } from '@playwright/test';
import { API_URL } from './session.js';
import { uploadTelemetry, type CsvReading } from './telemetry.js';
import { listUnallocated } from './unallocated.js';

/**
 * Fleet helpers for the browser tests: the GET /api/farms shape, reading it from the page's own
 * response (so expectations follow whatever the DB holds: the db:seed fixture in CI, plus the
 * demo data, the demo feed and earlier runs' turbines locally), and the side nav.
 */

export interface FleetReading {
  turbineId: string;
  farmId: string;
  timestamp: string;
  powerOutputKw: number;
  windSpeedMs: number;
  gearboxTempC: number;
}

export interface FleetTurbine {
  id: string;
  commissioned: boolean;
  latest: FleetReading | null;
}

export interface FleetFarm {
  id: string;
  name: string;
  turbines: FleetTurbine[];
}

/** The side nav ("Main" landmark). */
export const mainNav = (page: Page) => page.getByRole('navigation', { name: 'Main' });

/** The next GET /api/farms response of the page (start waiting before the action). */
export const farmsResponse = (page: Page): Promise<Response> =>
  page.waitForResponse(
    (r) => /\/api\/farms$/.test(new URL(r.url()).pathname) && r.request().method() === 'GET',
  );

export async function farmsFrom(response: Promise<Response>): Promise<FleetFarm[]> {
  const res = await response;
  expect(res.status(), 'GET /api/farms').toBe(200);
  return (await res.json()) as FleetFarm[];
}

/** GET /api/farms through the API (setup and oracles outside the page). */
export async function fetchFarms(request: APIRequestContext, token: string): Promise<FleetFarm[]> {
  const response = await request.get(`${API_URL}/farms`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status(), 'GET /api/farms').toBe(200);
  return (await response.json()) as FleetFarm[];
}

/** Every turbine with its farm. */
export function turbinesOf(farms: FleetFarm[]): (FleetTurbine & { farm: FleetFarm })[] {
  return farms.flatMap((farm) => farm.turbines.map((t) => ({ ...t, farm })));
}

/**
 * Adds a turbine to the fleet the way a real one joins it: its readings are uploaded through the
 * ingestion worker (held, since the id is unknown), then the owner assigns it to `farmId` through
 * the API, which imports them. There is no turbine delete API, so use an id unique to the run.
 */
export async function createTurbine(
  request: APIRequestContext,
  ownerToken: string,
  turbineId: string,
  farmId: string,
  readings: Omit<CsvReading, 'turbineId' | 'farmId'>[],
): Promise<void> {
  const held = await uploadTelemetry(
    request,
    readings.map((r) => ({ ...r, turbineId, farmId })),
  );
  expect(held).toMatchObject({ held: readings.length, inserted: 0 });
  const [entry] = (await listUnallocated(request, ownerToken, 'pending')).filter(
    (e) => e.turbineId === turbineId,
  );
  expect(entry, `${turbineId} is held`).toBeTruthy();
  const assigned = await request.post(`${API_URL}/unallocated-turbines/${entry.id}/assign`, {
    data: { farmId },
    headers: { Authorization: `Bearer ${ownerToken}` },
  });
  expect(assigned.status(), await assigned.text()).toBe(200);
}
