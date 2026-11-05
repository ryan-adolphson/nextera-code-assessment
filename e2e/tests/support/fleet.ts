import {
  expect,
  type APIRequestContext,
  type Page,
  type Request,
  type Response,
} from "@playwright/test";
import { API_URL } from "./session.js";
import { uploadTelemetry, type CsvReading } from "./telemetry.js";
import { listUnallocated } from "./unallocated.js";

/**
 * Fleet helpers for the browser tests: the fleet as an oracle (read through the API's paged
 * endpoints, since the web app no longer loads GET /api/farms), the summaries the page rendered,
 * and the side nav. Expectations follow whatever the DB holds: the db:seed fixture in CI, plus the
 * demo data, the demo feed and earlier runs' turbines locally.
 *
 * The server decides reporting / stale / no-data on ITS clock, the pills on the browser's fixed
 * clock (SEED_NOW): they disagree on the fixture, so the status filter and the summary tiles are
 * checked against the API's own answer, the pills against SEED_NOW.
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

/** One row of GET /api/turbines. */
export interface TurbineItem extends FleetTurbine {
  farmId: string;
  farmName: string;
  latitude: number;
  longitude: number;
}

/** GET /api/turbines?…: one page (keyset paging). */
export interface TurbinePage {
  items: TurbineItem[];
  nextCursor: string | null;
  prevCursor: string | null;
  total: number;
  totalCapped: boolean;
}

/** GET /api/fleet/summary. */
export interface FleetSummary {
  farms: number;
  turbines: number;
  commissioned: number;
  reporting: number;
  stale: number;
  alerting: number;
  powerOutputKw: number;
  asOf: string | null;
}

/** One entry of GET /api/farm-summaries. */
export interface FarmSummary {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  turbineCount: number;
  commissioned: number;
  reporting: number;
  stale: number;
  alerting: number;
  powerOutputKw: number;
  windSpeedMs: number | null;
  asOf: string | null;
}

export interface FleetFarm {
  id: string;
  name: string;
  turbines: FleetTurbine[];
}

/** The side nav ("Main" landmark). */
export const mainNav = (page: Page) =>
  page.getByRole("navigation", { name: "Main" });

/** Whether the request is a GET of `/api/<path>` (any query). */
export const isApiRequest = (request: Request, path: string): boolean =>
  request.method() === "GET" &&
  new URL(request.url()).pathname.endsWith(`/api/${path}`);

/** Whether the response answers a GET of `/api/<path>` (any query). */
export const isApiGet = (response: Response, path: string): boolean =>
  isApiRequest(response.request(), path);

/** The next GET /api/farm-summaries and /api/fleet/summary answers of the page (wait before acting). */
export async function waitForSummaries(
  page: Page,
): Promise<{ fleet: FleetSummary; farms: FarmSummary[] }> {
  const fleet = page.waitForResponse((r) => isApiGet(r, "fleet/summary"));
  const farms = page.waitForResponse((r) => isApiGet(r, "farm-summaries"));
  const [f, fa] = await Promise.all([fleet, farms]);
  expect(f.status(), "GET /api/fleet/summary").toBe(200);
  expect(fa.status(), "GET /api/farm-summaries").toBe(200);
  return {
    fleet: (await f.json()) as FleetSummary,
    farms: (await fa.json()) as FarmSummary[],
  };
}

/** The next GET /api/turbines of the page whose query satisfies `match` (wait before acting). */
export const turbinesResponse = (
  page: Page,
  match: (params: URLSearchParams) => boolean = () => true,
): Promise<Response> =>
  page.waitForResponse(
    (r) => isApiGet(r, "turbines") && match(new URL(r.url()).searchParams),
  );

/** The signed-in page's access token (from its session in localStorage). */
export async function pageToken(page: Page): Promise<string> {
  let token: string | null = null;
  await expect
    .poll(async () => {
      token = await page
        .evaluate(
          () =>
            (
              JSON.parse(localStorage.getItem("nextera.session") ?? "null") as {
                accessToken: string;
              } | null
            )?.accessToken ?? null,
        )
        .catch(() => null); // a navigation in flight
      return token;
    })
    .not.toBeNull();
  return token!;
}

/** GET /api/turbines?… through the API (an oracle for what the table must show). */
export async function fetchTurbinePage(
  request: APIRequestContext,
  token: string,
  query: Record<string, string | number | boolean>,
): Promise<TurbinePage> {
  const params = new URLSearchParams(
    Object.entries(query).map(([k, v]) => [k, String(v)]),
  );
  const response = await request.get(`${API_URL}/turbines?${params}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(
    response.status(),
    `GET /api/turbines?${params}: ${await response.text()}`,
  ).toBe(200);
  return (await response.json()) as TurbinePage;
}

/** One turbine with its latest reading (GET /api/turbines/:id). */
export async function fetchTurbine(
  request: APIRequestContext,
  token: string,
  id: string,
): Promise<TurbineItem> {
  const response = await request.get(`${API_URL}/turbines/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status(), `GET /api/turbines/${id}`).toBe(200);
  return (await response.json()) as TurbineItem;
}

/**
 * The whole fleet, farm by farm, read through GET /api/farm-summaries and GET /api/turbines (100 a
 * page, by id). Only for small fleets (the fixture, the 200-turbine demo): at a million turbines
 * the oracle would be the million.
 */
export async function fetchFarms(
  request: APIRequestContext,
  token: string,
): Promise<FleetFarm[]> {
  const summaries = await request.get(`${API_URL}/farm-summaries`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(summaries.status(), "GET /api/farm-summaries").toBe(200);
  const farms = (await summaries.json()) as FarmSummary[];
  const fleet: FleetFarm[] = [];
  for (const farm of farms) {
    const turbines: FleetTurbine[] = [];
    let cursor: string | null = null;
    do {
      const query: Record<string, string | number> = {
        farmId: farm.id,
        sort: "id",
        dir: "asc",
        limit: 100,
      };
      if (cursor) query["cursor"] = cursor;
      const page: TurbinePage = await fetchTurbinePage(request, token, query);
      turbines.push(...page.items);
      cursor = page.nextCursor;
    } while (cursor);
    fleet.push({ id: farm.id, name: farm.name, turbines });
  }
  return fleet;
}

/**
 * The fleet as the API holds it once the signed-in page has loaded its summaries (start before
 * the sign-in; replaces the old wait for GET /api/farms, which the web app no longer calls).
 */
export async function farmsResponse(page: Page): Promise<FleetFarm[]> {
  await page.waitForResponse((r) => isApiGet(r, "farm-summaries"));
  return fetchFarms(page.request, await pageToken(page));
}

/** Kept for call sites that await `farmsFrom(farmsResponse(page))`. */
export const farmsFrom = (farms: Promise<FleetFarm[]>): Promise<FleetFarm[]> =>
  farms;

/** PATCH /api/turbines/:id through the API (setup and cleanup): expects 200. */
export async function setCommissioned(
  request: APIRequestContext,
  token: string,
  turbineId: string,
  commissioned: boolean,
): Promise<void> {
  const response = await request.patch(`${API_URL}/turbines/${turbineId}`, {
    data: { commissioned },
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status(), await response.text()).toBe(200);
}

/** Every turbine with its farm. */
export function turbinesOf(
  farms: FleetFarm[],
): (FleetTurbine & { farm: FleetFarm })[] {
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
  readings: Omit<CsvReading, "turbineId" | "farmId">[],
): Promise<void> {
  const held = await uploadTelemetry(
    request,
    readings.map((r) => ({ ...r, turbineId, farmId })),
  );
  expect(held).toMatchObject({ held: readings.length, inserted: 0 });
  const [entry] = (
    await listUnallocated(request, ownerToken, "pending")
  ).filter((e) => e.turbineId === turbineId);
  expect(entry, `${turbineId} is held`).toBeTruthy();
  const assigned = await request.post(
    `${API_URL}/unallocated-turbines/${entry.id}/assign`,
    {
      data: { farmId },
      headers: { Authorization: `Bearer ${ownerToken}` },
    },
  );
  expect(assigned.status(), await assigned.text()).toBe(200);
}
