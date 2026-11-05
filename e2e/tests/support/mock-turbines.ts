import type { Page } from "@playwright/test";
import { SEED_NOW } from "./session.js";
import type { TurbineItem, TurbinePage } from "./fleet.js";

/**
 * A stand-in for GET /api/turbines for the tests that need a fleet the fixture doesn't have (more
 * than a page, a never-reported turbine, ties). It answers like the API: the filters (farmId, q,
 * status, commissioned, hasData), the sort (id, farm, commissioned, time, power, wind, gearbox;
 * turbines without a reading last, ties by id) and keyset paging (here: an offset as the cursor,
 * `limit` rows a page, the total counted in full). Its `status` is judged at SEED_NOW, the page's
 * fixed clock, since a mock has no clock of its own. Everything else (summaries, markers, the
 * stream) stays real unless the test mocks it. Every request it served is in `requests`. The
 * array passed in is the "database": a test changes a turbine's `latest` to change what the next
 * request (the page is fetched again each time the stream opens) returns.
 */

export interface MockReading {
  id: string;
  turbineId: string;
  farmId: string;
  timestamp: string;
  receivedAt: string;
  powerOutputKw: number;
  windSpeedMs: number;
  rotorRpm: number;
  bladePitchDeg: number;
  gearboxTempC: number;
  alerts: never[];
}

export type MockTurbine = TurbineItem & { latest: MockReading | null };

const minutesAgo = (minutes: number) =>
  new Date(SEED_NOW.getTime() - minutes * 60_000).toISOString();

/** A reading `ageMinutes` before SEED_NOW (also what a telemetry.received event carries). */
export const mockReading = (
  turbineId: string,
  farmId: string,
  ageMinutes: number,
  powerOutputKw = 1000,
): MockReading => ({
  id: `reading-${turbineId}-${ageMinutes}`,
  turbineId,
  farmId,
  timestamp: minutesAgo(ageMinutes),
  receivedAt: minutesAgo(ageMinutes),
  powerOutputKw,
  windSpeedMs: 8,
  rotorRpm: 12,
  bladePitchDeg: 4,
  gearboxTempC: 70,
  alerts: [],
});

/** A mocked turbine: `ageMinutes` since its latest reading, or null if it has never reported. */
export const mockTurbine = (
  id: string,
  farmId: string,
  ageMinutes: number | null,
  {
    power = 1000,
    farmName = farmId === "FARM01" ? "Prairie Ridge" : "High Plains",
    commissioned = true,
  } = {},
): MockTurbine => ({
  id,
  farmId,
  farmName,
  latitude: 35.1,
  longitude: -101.2,
  commissioned,
  latest:
    ageMinutes === null ? null : mockReading(id, farmId, ageMinutes, power),
});

const status = (t: MockTurbine) =>
  !t.latest
    ? "no_data"
    : SEED_NOW.getTime() - Date.parse(t.latest.timestamp) > 15 * 60_000
      ? "stale"
      : "reporting";

const SORT: Record<string, (t: MockTurbine) => string | number | null> = {
  id: (t) => t.id,
  farm: (t) => t.farmName,
  commissioned: (t) => (t.commissioned ? 0 : 1),
  time: (t) => t.latest?.timestamp ?? null,
  power: (t) => t.latest?.powerOutputKw ?? null,
  wind: (t) => t.latest?.windSpeedMs ?? null,
  gearbox: (t) => t.latest?.gearboxTempC ?? null,
};

/** The API's answer for `params` over `turbines`. */
export function pageOf(
  turbines: MockTurbine[],
  params: URLSearchParams,
): TurbinePage {
  const q = params.get("q")?.toLowerCase();
  const value = SORT[params.get("sort") ?? "id"] ?? SORT["id"];
  const dir = params.get("dir") === "desc" ? -1 : 1;
  const matching = turbines
    .filter(
      (t) =>
        (!params.get("farmId") || t.farmId === params.get("farmId")) &&
        (!q ||
          [t.id, t.farmId, t.farmName].some((s) =>
            s.toLowerCase().includes(q),
          )) &&
        (!params.get("status") || status(t) === params.get("status")) &&
        (!params.has("commissioned") ||
          t.commissioned === (params.get("commissioned") === "true")) &&
        (params.get("hasData") !== "true" || t.latest !== null),
    )
    .sort((a, b) => {
      const [x, y] = [value(a), value(b)];
      if (x === y) return a.id.localeCompare(b.id);
      if (x === null) return 1;
      if (y === null) return -1;
      return (
        dir *
        (typeof x === "number"
          ? x - (y as number)
          : x.localeCompare(y as string))
      );
    });
  const start = Number(params.get("cursor") ?? 0);
  const limit = Number(params.get("limit") ?? 25);
  return {
    items: matching.slice(start, start + limit),
    nextCursor: start + limit < matching.length ? String(start + limit) : null,
    prevCursor: start > 0 ? String(Math.max(0, start - limit)) : null,
    total: matching.length,
    totalCapped: false,
  };
}

/** Serves GET /api/turbines from `turbines`; `requests` collects the query of each call. */
export async function mockTurbines(
  page: Page,
  turbines: MockTurbine[],
  { capTotalAt }: { capTotalAt?: number } = {},
): Promise<{ requests: URLSearchParams[] }> {
  const requests: URLSearchParams[] = [];
  await page.route(
    (url) => url.pathname.endsWith("/api/turbines"),
    async (route) => {
      const params = new URL(route.request().url()).searchParams;
      requests.push(params);
      const answer = pageOf(turbines, params);
      // The real API counts up to 10,001 and then says so: pretend the fleet is bigger.
      if (capTotalAt)
        Object.assign(answer, { total: capTotalAt + 1, totalCapped: true });
      await route.fulfill({ json: answer });
    },
  );
  return { requests };
}
