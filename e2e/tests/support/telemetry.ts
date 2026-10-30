import { expect, type APIRequestContext } from '@playwright/test';
import { API_URL, INGESTION_URL } from './session.js';

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
  'turbine_id,farm_id,timestamp,received_at,power_output_kw,wind_speed_ms,rotor_rpm,blade_pitch_deg,gearbox_temp_c';

export function telemetryCsv(readings: CsvReading[]): string {
  const rows = readings.map((r) =>
    [
      r.turbineId,
      r.farmId,
      r.timestamp,
      '',
      r.powerOutputKw ?? 1500,
      r.windSpeedMs ?? 7.5,
      r.rotorRpm ?? 13,
      r.bladePitchDeg ?? 4,
      r.gearboxTempC ?? 70,
    ].join(','),
  );
  return [HEADER, ...rows].join('\n') + '\n';
}

/** POSTs readings as a telemetry.csv upload to the ingestion worker (expects 201). */
export async function uploadTelemetry(
  request: APIRequestContext,
  readings: CsvReading[],
): Promise<BatchResult> {
  const response = await request.post(`${INGESTION_URL}/ingest/telemetry`, {
    multipart: {
      file: {
        name: 'e2e-readings.csv',
        mimeType: 'text/csv',
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
