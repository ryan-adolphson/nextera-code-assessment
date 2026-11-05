import { openMigrationDb, type MigrationDb } from './migration-db.js';

const TARGET = '20261104130000_scale_read_indexes';

/**
 * The read-index migration: purely additive for the previous revision (rows survive, the replaced
 * indexes were prefixes of the new ones), and the schema has no drift.
 */
describe('migration scale_read_indexes (e2e)', () => {
  let m: MigrationDb;

  beforeAll(async () => {
    m = await openMigrationDb(TARGET);
    await m.migrateBeforeTarget();
  });

  afterAll(async () => {
    await m?.close();
  });

  const indexes = async (table: string) =>
    (
      await m.db.query<{ indexname: string }>(
        `SELECT indexname FROM pg_indexes WHERE tablename = $1 ORDER BY 1`,
        [table],
      )
    ).rows.map((r) => r.indexname);

  it('keeps existing rows, swaps the prefix indexes and adds the keyset ones, with no drift', async () => {
    await m.db.query(
      `INSERT INTO farms (id, name, latitude, longitude) VALUES ('F1', 'One', 1, 2)`,
    );
    await m.db.query(
      `INSERT INTO turbines (turbine_id, farm_id, latitude, longitude) VALUES ('T1', 'F1', 1, 2)`,
    );
    await m.db.query(
      `INSERT INTO turbine_latest (turbine_id, farm_id, reading_id, "timestamp", received_at,
         power_output_kw, wind_speed_ms, rotor_rpm, blade_pitch_deg, gearbox_temp_c)
       VALUES ('T1', 'F1', gen_random_uuid(), now(), now(), 1, 1, 1, 1, 1)`,
    );
    expect(await indexes('turbines')).toContain('turbines_farm_id_idx');

    await m.migrateTarget();

    const turbines = await indexes('turbines');
    expect(turbines).not.toContain('turbines_farm_id_idx');
    expect(turbines).toEqual(
      expect.arrayContaining([
        'turbines_farm_id_turbine_id_idx',
        'turbines_commissioned_turbine_id_idx',
        'turbines_turbine_id_trgm_idx',
      ]),
    );
    const latest = await indexes('turbine_latest');
    expect(latest).toContain('turbine_latest_timestamp_turbine_id_idx');
    expect(latest).not.toContain('turbine_latest_timestamp_idx');
    expect(await indexes('telemetry_alerts')).toContain(
      'telemetry_alerts_reading_timestamp_telemetry_id_idx',
    );
    expect(
      (await m.db.query(`SELECT turbine_id FROM turbine_latest`)).rows,
    ).toEqual([{ turbine_id: 'T1' }]);
    expect(() => m.diffAgainstSchema()).not.toThrow();
  });

  it('a daily partition created later gets the alerts index too', async () => {
    await m.db.query(`SELECT telemetry_ensure_partition('2026-05-01')`);
    expect(await indexes('telemetry_alerts_p20260501')).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/reading_timestamp_telemetry_id_idx$/),
      ]),
    );
  });
});
