import { expect, type APIRequestContext, type Page } from "@playwright/test";
import { API_URL, INGESTION_URL } from "./session.js";

/** One telemetry.csv row (received_at empty: ingestion uses the upload time). */
export interface CsvReading {
  turbineId: string;
  farmId: string;
  timestamp: string;
  powerOutputKw?: number;
  windSpeedMs?: number;
  rotorRpm?: number;
  bladePitchDeg?: number;
  gearboxTempC?: number;
}

/** The ingestion worker's answer to a CSV upload. */
export interface BatchResult {
  rows: number;
  inserted: number;
  duplicates: number;
  held: number;
  blocked: number;
  turbines: string[];
}

const HEADER =
  "turbine_id,farm_id,timestamp,received_at,power_output_kw,wind_speed_ms,rotor_rpm,blade_pitch_deg,gearbox_temp_c";

export function telemetryCsv(readings: CsvReading[]): string {
  const rows = readings.map((r) =>
    [
      r.turbineId,
      r.farmId,
      r.timestamp,
      "",
      r.powerOutputKw ?? 1500,
      r.windSpeedMs ?? 7.5,
      r.rotorRpm ?? 13,
      r.bladePitchDeg ?? 4,
      r.gearboxTempC ?? 70,
    ].join(","),
  );
  return [HEADER, ...rows].join("\n") + "\n";
}

/** POSTs readings as a telemetry.csv upload to the ingestion worker (expects 201). */
export async function uploadTelemetry(
  request: APIRequestContext,
  readings: CsvReading[],
): Promise<BatchResult> {
  const response = await request.post(`${INGESTION_URL}/ingest/telemetry`, {
    multipart: {
      file: {
        name: "e2e-readings.csv",
        mimeType: "text/csv",
        buffer: Buffer.from(telemetryCsv(readings)),
      },
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  return (await response.json()) as BatchResult;
}

/** GET /api/turbines/:id/telemetry for [from, to). */
export async function turbineTelemetry(
  request: APIRequestContext,
  token: string,
  turbineId: string,
  from: string,
  to: string,
): Promise<{ farmId: string; timestamp: string; powerOutputKw: number }[]> {
  const response = await request.get(
    `${API_URL}/turbines/${encodeURIComponent(turbineId)}/telemetry`,
    { params: { from, to }, headers: { Authorization: `Bearer ${token}` } },
  );
  expect(response.status()).toBe(200);
  return response.json();
}

/**
 * Bounds the turbine page's history and stats requests at `at` (adds `to`). The app asks for
 * `?from=<window start>&limit=…` without `to` (its window ends at "now" and live readings join
 * it), so the API answers the newest readings after `from`. With a fixed browser clock and a DB
 * that also holds later readings (db:seed:demo, the demo feed), those later rows fill the limit
 * and the fixture's day disappears from the page. With the db:seed fixture alone (CI) this
 * changes nothing; the rows still come from the real API.
 */
export async function boundTelemetryAt(page: Page, at: Date): Promise<void> {
  await page.route(
    (url) => /\/api\/turbines\/[^/]+\/telemetry(\/stats)?$/.test(url.pathname),
    async (route) => {
      const url = new URL(route.request().url());
      if (!url.searchParams.has("to"))
        url.searchParams.set("to", at.toISOString());
      await route.continue({ url: url.toString() });
    },
  );
}
