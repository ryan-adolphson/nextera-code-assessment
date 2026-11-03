import { openMigrationDb, type MigrationDb } from './migration-db.js';

const TARGET = '20261031120000_farm_weather';

/**
 * Adds the `farm_weather` table (30-minute buckets). Expand-only, so prove it:
 * existing fleet data survives, the running revision's writes keep working, the new table has its
 * key, defaults and FK (deleting a farm deletes its weather), and there is no drift.
 */
describe(`migration ${TARGET} (e2e)`, () => {
  let m: MigrationDb;

  beforeAll(async () => {
    m = await openMigrationDb(TARGET);
  });

  afterAll(async () => {
    await m?.close();
  });

  const insertReading = (timestamp: string) =>
    m.db.query(
      `INSERT INTO telemetry (turbine_id, farm_id, timestamp, power_output_kw, wind_speed_ms,
                              rotor_rpm, blade_pitch_deg, gearbox_temp_c)
       VALUES ('TURB001', 'FARM01', $1, 2200, 8.5, 13, 4, 80)`,
      [timestamp],
    );

  it('keeps existing farms, turbines and telemetry', async () => {
    await m.migrateBeforeTarget();
    await m.db.query(`
      INSERT INTO farms (id, name, latitude, longitude) VALUES
        ('FARM01', 'Prairie Ridge', 41.25, -96.53),
        ('FARM02', 'Empty Farm', 42.5, -97.5);
      INSERT INTO turbines (turbine_id, farm_id, latitude, longitude)
        VALUES ('TURB001', 'FARM01', 41.263, -96.518);
    `);
    await insertReading('2026-01-02T03:25:00Z');

    expect(await m.migrateTarget()).toContain(TARGET);

    const { rows } = await m.db.query(`
      SELECT (SELECT count(*) FROM farms)::int AS farms,
             (SELECT count(*) FROM turbines)::int AS turbines,
             (SELECT count(*) FROM telemetry)::int AS telemetry,
             (SELECT count(*) FROM farm_weather)::int AS weather`);
    expect(rows[0]).toEqual({
      farms: 2,
      turbines: 1,
      telemetry: 1,
      weather: 0,
    });
    // The running revision's inserts are unaffected.
    await insertReading('2026-01-02T03:30:00Z');
  });

  it('stores a bucket with nullable metrics and fetched_at by default; one row per farm and bucket', async () => {
    const { rows } = await m.db.query(`
      INSERT INTO farm_weather (farm_id, time, samples, wind_speed_80m_ms)
      VALUES ('FARM01', '2026-01-01T00:30:00Z', 2, 10.78)
      RETURNING samples, wind_speed_10m_ms, wind_speed_80m_ms, fetched_at`);
    expect(rows[0]).toMatchObject({
      samples: 2,
      wind_speed_10m_ms: null,
      wind_speed_80m_ms: 10.78,
    });
    expect(rows[0].fetched_at).toBeInstanceOf(Date);

    await expect(
      m.db.query(`
        INSERT INTO farm_weather (farm_id, time, samples)
        VALUES ('FARM01', '2026-01-01T00:30:00Z', 1)`),
    ).rejects.toThrow(/farm_weather_pkey/);
    await expect(
      m.db.query(`
        INSERT INTO farm_weather (farm_id, time, samples)
        VALUES ('FARM99', '2026-01-01T00:00:00Z', 2)`),
    ).rejects.toThrow(/farm_weather_farm_id_fkey/);
    await expect(
      m.db.query(`
        INSERT INTO farm_weather (farm_id, time)
        VALUES ('FARM01', '2026-01-01T01:00:00Z')`),
    ).rejects.toThrow(/null value in column "samples"/);
  });

  it('deletes a farm’s weather with the farm', async () => {
    await m.db.query(`
      INSERT INTO farm_weather (farm_id, time, samples)
      VALUES ('FARM02', '2026-01-01T00:00:00Z', 2)`);
    await m.db.query(`DELETE FROM farms WHERE id = 'FARM02'`);
    const { rows } = await m.db.query(
      `SELECT count(*)::int AS n FROM farm_weather WHERE farm_id = 'FARM02'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('leaves no drift between the migrated database and schema.prisma', async () => {
    await m.migrateAll();
    expect(m.diffAgainstSchema()).toContain('No difference detected');
  });
});
