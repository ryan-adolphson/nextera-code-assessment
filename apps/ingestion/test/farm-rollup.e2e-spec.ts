import type { ConfigService } from '@nestjs/config';
import {
  EVENT_STREAM_KEY,
  EventStore,
  FARM_ROLLUP_COMPLETED,
} from '@nextera/shared';
import { Redis } from 'ioredis';
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

  it('publishes farm-rollup.completed to the stream once the rows are visible', async () => {
    const redis = new Redis(process.env.REDIS_URL!);
    try {
      const before = await redis.xlen(EVENT_STREAM_KEY);
      let rowsAtPublish = -1;
      const events = new EventStore({
        getOrThrow: (k: string) => process.env[k],
      } as unknown as ConfigService);
      const publish = events.publish.bind(events);
      events.publish = async (type, data) => {
        rowsAtPublish = await t.prisma.farmTelemetryRollup.count();
        return publish(type, data);
      };
      const day = new Date(Date.now() - 24 * 3_600_000)
        .toISOString()
        .slice(0, 10);
      expect(
        (await upload([`TURB001,FARM01,${day}T10:00:00Z,,1000,9,14,3,80`]))
          .status,
      ).toBe(201);
      const code = await runFarmRollupCli({
        argv: ['--full'],
        env: {
          DATABASE_URL: process.env.DATABASE_URL,
          REDIS_URL: process.env.REDIS_URL,
        },
        createEvents: () => events,
        log,
      });
      expect(code).toBe(0);
      const entries = await redis.xrange(EVENT_STREAM_KEY, '-', '+');
      expect(entries.length).toBe(before + 1);
      const fields = entries[entries.length - 1][1];
      const event = JSON.parse(fields[fields.indexOf('event') + 1]);
      expect(event.type).toBe(FARM_ROLLUP_COMPLETED);
      expect(event.data.asOf).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
      expect(rowsAtPublish).toBeGreaterThan(0);
    } finally {
      redis.disconnect();
    }
  });
});
