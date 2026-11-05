import { createTestApp, type TestApp } from './helpers.js';
import { runFarmRollupCli } from '../src/farm-rollup/farm-rollup.js';

const HEADER =
  'turbine_id,farm_id,timestamp,received_at,power_output_kw,wind_speed_ms,rotor_rpm,blade_pitch_deg,gearbox_temp_c';

/**
 * The farm rollup runner (what `node dist/farm-rollup/main.js` runs) against the worker's database:
 * a CSV backfill of old readings, uploaded after a run, reaches the rollups through the incremental
 * scan (telemetry.created_at), not just the current day.
 */
describe('farm rollup runner after a CSV backfill (e2e)', () => {
  let t: TestApp;
  const log = { log: vi.fn(), error: vi.fn() };

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await t.prisma
      .$executeRaw`TRUNCATE TABLE turbine_latest, telemetry_alerts, telemetry, held_telemetry, unallocated_turbines, farm_telemetry_rollups, farm_rollup_state, farm_rollup_dirty`;
  });

  const rollup = (argv: string[] = []) =>
    runFarmRollupCli({
      argv,
      env: { DATABASE_URL: process.env.DATABASE_URL }, // the e2e Postgres (setup-e2e)
      log,
    });

  const upload = (rows: string[]) => {
    const form = new FormData();
    form.append(
      'file',
      new Blob([[HEADER, ...rows].join('\n')], { type: 'text/csv' }),
      'backfill.csv',
    );
    return fetch(`${t.url}/ingest/telemetry`, { method: 'POST', body: form });
  };

  it('picks up a backfill of last week on the next incremental run', async () => {
    expect(await rollup()).toBe(0); // first run: nothing yet
    const day = new Date(Date.now() - 7 * 24 * 3_600_000)
      .toISOString()
      .slice(0, 10);

    const res = await upload([
      `TURB001,FARM01,${day}T10:00:00Z,,1000,9,14,3,80`,
      `TURB001,FARM01,${day}T10:05:00Z,,1200,10,14,3,81`,
      `TURB001,FARM01,${day}T10:10:00Z,,800,8,14,3,82`,
    ]);
    expect(res.status).toBe(201);
    expect(await rollup()).toBe(0);

    const rows = await t.prisma.farmTelemetryRollup.findMany({
      where: { farmId: 'FARM01' },
    });
    expect(rows).toEqual([
      expect.objectContaining({
        bucketStart: new Date(`${day}T10:00:00Z`),
        readings: 3,
        turbines: 1,
        powerOpen: 1000,
        powerClose: 800,
        powerHigh: 1200,
        powerLow: 800,
      }),
    ]);
    expect(log.error).not.toHaveBeenCalled();
  });
});
