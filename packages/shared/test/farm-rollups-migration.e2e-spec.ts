import { openMigrationDb, type MigrationDb } from './migration-db.js';

const TARGET = '20261101120000_farm_telemetry_rollups';

/**
 * Adds farm_telemetry_rollups, farm_rollup_state, farm_rollup_dirty, an index on
 * telemetry.created_at and the turbines trigger that marks farms dirty on a move. Expand-only, so
 * prove it: existing data survives, the running revision's writes (readings, a move) keep working,
 * the new tables have their keys and FK, the trigger fires only when farm_id changes, and there is
 * no drift (Prisma doesn't model the trigger, so `migrate diff` must not see it either).
 */
describe(`migration ${TARGET} (e2e)`, () => {
  let m: MigrationDb;

  beforeAll(async () => {
    m = await openMigrationDb(TARGET);
  });

  afterAll(async () => {
    await m?.close();
  });

  const insertReading = (
    turbineId: string,
    farmId: string,
    timestamp: string,
  ) =>
    m.db.query(
      `INSERT INTO telemetry (turbine_id, farm_id, timestamp, power_output_kw, wind_speed_ms,
                              rotor_rpm, blade_pitch_deg, gearbox_temp_c)
       VALUES ($1, $2, $3, 2200, 8.5, 13, 4, 80)`,
      [turbineId, farmId, timestamp],
    );

  it('keeps existing farms, turbines and telemetry', async () => {
    await m.migrateBeforeTarget();
    await m.db.query(`
      INSERT INTO farms (id, name, latitude, longitude) VALUES
        ('FARM01', 'Prairie Ridge', 41.25, -96.53),
        ('FARM02', 'Other Farm', 42.5, -97.5),
        ('FARM03', 'Empty Farm', 43.5, -98.5);
      INSERT INTO turbines (turbine_id, farm_id, latitude, longitude) VALUES
        ('TURB001', 'FARM01', 41.263, -96.518),
        ('TURB002', 'FARM01', 41.264, -96.519);
    `);
    await insertReading('TURB001', 'FARM01', '2026-01-02T03:25:00Z');
    await insertReading('TURB001', 'FARM01', '2026-01-01T00:00:00Z');

    expect(await m.migrateTarget()).toContain(TARGET);

    const { rows } = await m.db.query(`
      SELECT (SELECT count(*) FROM farms)::int AS farms,
             (SELECT count(*) FROM turbines)::int AS turbines,
             (SELECT count(*) FROM telemetry)::int AS telemetry,
             (SELECT count(*) FROM farm_telemetry_rollups)::int AS rollups,
             (SELECT count(*) FROM farm_rollup_state)::int AS state,
             (SELECT count(*) FROM farm_rollup_dirty)::int AS dirty`);
    expect(rows[0]).toEqual({
      farms: 3,
      turbines: 2,
      telemetry: 2,
      rollups: 0,
      state: 0,
      dirty: 0,
    });
    // The running revision's inserts are unaffected.
    await insertReading('TURB001', 'FARM01', '2026-01-02T03:30:00Z');
  });

  it('indexes telemetry.created_at for the incremental scan', async () => {
    const { rows } = await m.db.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'telemetry_created_at_idx'`,
    );
    expect(rows[0].indexdef).toContain('(created_at)');
  });

  it('marks both farms dirty from the first reading when a turbine moves (the running revision’s move still works)', async () => {
    await m.db.query(
      `UPDATE turbines SET commissioned = true WHERE turbine_id = 'TURB001'`,
    );
    await m.db.query(
      `UPDATE turbines SET farm_id = 'FARM02' WHERE turbine_id = 'TURB002'`,
    ); // no readings
    expect((await m.db.query('SELECT * FROM farm_rollup_dirty')).rows).toEqual(
      [],
    );

    await m.db.query(
      `UPDATE turbines SET farm_id = 'FARM02' WHERE turbine_id = 'TURB001'`,
    );

    const { rows } = await m.db.query(
      `SELECT farm_id, from_time FROM farm_rollup_dirty ORDER BY farm_id`,
    );
    expect(rows).toEqual([
      { farm_id: 'FARM01', from_time: new Date('2026-01-01T00:00:00Z') },
      { farm_id: 'FARM02', from_time: new Date('2026-01-01T00:00:00Z') },
    ]);
    const moved = await m.db.query(
      `SELECT DISTINCT farm_id FROM telemetry WHERE turbine_id = 'TURB001'`,
    );
    expect(moved.rows).toEqual([{ farm_id: 'FARM02' }]); // the cascade still applies
  });

  it('a rolled-back move leaves no marker', async () => {
    await m.db.query('DELETE FROM farm_rollup_dirty');
    await m.db.query('BEGIN');
    await m.db.query(
      `UPDATE turbines SET farm_id = 'FARM01' WHERE turbine_id = 'TURB001'`,
    );
    await m.db.query('ROLLBACK');
    expect((await m.db.query('SELECT * FROM farm_rollup_dirty')).rows).toEqual(
      [],
    );
  });

  it('keys rollups by (farm, bucket) and deletes them with their farm', async () => {
    const insert = (farmId: string) =>
      m.db.query(
        `INSERT INTO farm_telemetry_rollups (farm_id, bucket_start, readings, turbines,
           power_open, power_close, power_high, power_low,
           wind_speed_open, wind_speed_close, wind_speed_high, wind_speed_low,
           rotor_rpm_open, rotor_rpm_close, rotor_rpm_high, rotor_rpm_low,
           blade_pitch_open, blade_pitch_close, blade_pitch_high, blade_pitch_low,
           gearbox_temp_open, gearbox_temp_close, gearbox_temp_high, gearbox_temp_low)
         VALUES ($1, '2026-01-01T00:00:00Z', 6, 1, ${Array(20).fill('1').join(', ')})
         RETURNING computed_at`,
        [farmId],
      );
    expect((await insert('FARM03')).rows[0].computed_at).toBeInstanceOf(Date);
    await expect(insert('FARM03')).rejects.toThrow(
      /farm_telemetry_rollups_pkey/,
    );
    await expect(insert('FARM99')).rejects.toThrow(
      /farm_telemetry_rollups_farm_id_fkey/,
    );

    await m.db.query(`DELETE FROM farms WHERE id = 'FARM03'`);
    const { rows } = await m.db.query(
      `SELECT count(*)::int AS n FROM farm_telemetry_rollups WHERE farm_id = 'FARM03'`,
    );
    expect(rows[0].n).toBe(0);
  });

  it('leaves no drift between the migrated database and schema.prisma', async () => {
    await m.migrateAll();
    expect(m.diffAgainstSchema()).toContain('No difference detected');
  });
});
