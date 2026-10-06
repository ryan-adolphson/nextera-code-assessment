import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { PrismaClient } from '../generated/prisma/client.js';

/** Minimal CSV parser for the seed files (no quoted fields). Validates the header and column counts. */
export function parseCsv(
  text: string,
  expectedColumns: readonly string[],
): Record<string, string>[] {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',').map((c) => c.trim());
  if (header.join(',') !== expectedColumns.join(',')) {
    throw new Error(
      `Unexpected CSV header "${header.join(',')}", expected "${expectedColumns.join(',')}"`,
    );
  }
  return lines.slice(1).map((line, i) => {
    const values = line.split(',').map((v) => v.trim());
    if (values.length !== header.length) {
      throw new Error(
        `CSV line ${i + 2}: ${values.length} values, expected ${header.length}`,
      );
    }
    return Object.fromEntries(header.map((column, j) => [column, values[j]]));
  });
}

const FARM_COLUMNS = ['farm_id', 'farm_name', 'latitude', 'longitude'] as const;
const TURBINE_COLUMNS = [
  'turbine_id',
  'farm_id',
  'farm_name',
  'latitude',
  'longitude',
] as const;
/** Columns of telemetry.csv: the format for seeding, CSV uploads and Pub/Sub messages. */
export const TELEMETRY_CSV_COLUMNS = [
  'turbine_id',
  'farm_id',
  'timestamp',
  'received_at',
  'power_output_kw',
  'wind_speed_ms',
  'rotor_rpm',
  'blade_pitch_deg',
  'gearbox_temp_c',
] as const;

const BATCH_SIZE = 1000;

export interface SeedResult {
  farms: number;
  turbines: number;
  telemetryInserted: number;
  telemetrySkipped: number;
}

/**
 * Loads farms.csv, turbines.csv and telemetry.csv from `dataDir`. Idempotent: farms and turbines
 * are upserted, telemetry rows already present (same turbine + timestamp) are skipped.
 */
export async function seedFromCsv(
  prisma: PrismaClient,
  dataDir: string,
): Promise<SeedResult> {
  const read = async (file: string, columns: readonly string[]) =>
    parseCsv(await readFile(join(dataDir, file), 'utf8'), columns);

  const farms = await read('farms.csv', FARM_COLUMNS);
  for (const f of farms) {
    const data = {
      name: f.farm_name,
      latitude: f.latitude,
      longitude: f.longitude,
    };
    await prisma.farm.upsert({
      where: { id: f.farm_id },
      create: { id: f.farm_id, ...data },
      update: data,
    });
  }

  const farmNames = new Map(farms.map((f) => [f.farm_id, f.farm_name]));
  const turbines = await read('turbines.csv', TURBINE_COLUMNS);
  for (const t of turbines) {
    // farm_name is redundant in turbines.csv: check it instead of storing it.
    if (farmNames.get(t.farm_id) !== t.farm_name) {
      throw new Error(
        `turbines.csv: ${t.turbine_id} names farm "${t.farm_name}", but ${t.farm_id} is "${farmNames.get(t.farm_id)}"`,
      );
    }
    const data = {
      farmId: t.farm_id,
      latitude: t.latitude,
      longitude: t.longitude,
    };
    await prisma.turbine.upsert({
      where: { id: t.turbine_id },
      create: { id: t.turbine_id, ...data },
      update: data,
    });
  }

  const telemetry = (await read('telemetry.csv', TELEMETRY_CSV_COLUMNS)).map(
    (r) => ({
      turbineId: r.turbine_id,
      farmId: r.farm_id,
      timestamp: new Date(r.timestamp),
      receivedAt: new Date(r.received_at),
      powerOutputKw: Number(r.power_output_kw),
      windSpeedMs: Number(r.wind_speed_ms),
      rotorRpm: Number(r.rotor_rpm),
      bladePitchDeg: Number(r.blade_pitch_deg),
      gearboxTempC: Number(r.gearbox_temp_c),
    }),
  );
  let inserted = 0;
  for (let i = 0; i < telemetry.length; i += BATCH_SIZE) {
    const { count } = await prisma.telemetry.createMany({
      data: telemetry.slice(i, i + BATCH_SIZE),
      skipDuplicates: true,
    });
    inserted += count;
  }

  return {
    farms: farms.length,
    turbines: turbines.length,
    telemetryInserted: inserted,
    telemetrySkipped: telemetry.length - inserted,
  };
}
