import { openMigrationDb, UUID, type MigrationDb } from './migration-db.js';

const TARGET = '20261029120000_unallocated_turbines';

/**
 * Adds the unallocated_kind / unallocated_status enums and the unallocated_turbines and
 * held_telemetry tables. Expand-only, so prove it: existing data survives, the running revision's
 * writes (which never name the new tables) keep working, the new tables have their defaults and
 * constraints, and the database has no drift from schema.prisma.
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

  const insertEntry = (turbineId: string, farmId: string, blockedBy?: string) =>
    m.db.query<{ id: string; status: string }>(
      `INSERT INTO unallocated_turbines (turbine_id, reported_farm_id, kind, first_seen_at,
                                         last_seen_at, blocked_by)
       VALUES ($1, $2, 'unknown_turbine', now(), now(), $3)
       RETURNING id::text, status::text`,
      [turbineId, farmId, blockedBy ?? null],
    );

  it('keeps existing farms, turbines, telemetry, alert rules and users', async () => {
    await m.migrateBeforeTarget();
    await m.db.query(`
      INSERT INTO farms (id, name, latitude, longitude) VALUES
        ('FARM01', 'Prairie Ridge', 41.25, -96.53),
        ('FARM02', 'High Plains', 39.74, -101.21);
      INSERT INTO turbines (turbine_id, farm_id, latitude, longitude)
        VALUES ('TURB001', 'FARM01', 41.263, -96.518);
      INSERT INTO alerts_config (measurement_metric, comparison, value_metric, alert_level)
        VALUES ('gearbox_temp_c', 'above', 120, 'error');
      INSERT INTO users (email, password_hash, role)
        VALUES ('owner@nextera.local', 'h', 'owner');
    `);
    await insertReading('2026-01-02T03:25:00Z');

    expect(await m.migrateTarget()).toContain(TARGET);

    const { rows } = await m.db.query(`
      SELECT (SELECT count(*) FROM farms)::int AS farms,
             (SELECT count(*) FROM turbines)::int AS turbines,
             (SELECT count(*) FROM telemetry)::int AS telemetry,
             (SELECT count(*) FROM alerts_config)::int AS rules,
             (SELECT count(*) FROM users)::int AS users,
             (SELECT count(*) FROM unallocated_turbines)::int AS unallocated,
             (SELECT count(*) FROM held_telemetry)::int AS held`);
    expect(rows[0]).toEqual({
      farms: 2,
      turbines: 1,
      telemetry: 1,
      rules: 1,
      users: 1,
      unallocated: 0,
      held: 0,
    });
    // The running revision's inserts are unaffected.
    await insertReading('2026-01-02T03:30:00Z');
  });

  it('keeps telemetry_turbine_id_farm_id_fkey ON UPDATE CASCADE: moving a turbine moves its history', async () => {
    const { rows } = await m.db.query(`
      SELECT confupdtype FROM pg_constraint WHERE conname = 'telemetry_turbine_id_farm_id_fkey'`);
    expect(rows).toEqual([{ confupdtype: 'c' }]);

    await m.db.query(
      `UPDATE turbines SET farm_id = 'FARM02' WHERE turbine_id = 'TURB001'`,
    );
    const moved = await m.db.query(
      `SELECT DISTINCT farm_id FROM telemetry WHERE turbine_id = 'TURB001'`,
    );
    expect(moved.rows).toEqual([{ farm_id: 'FARM02' }]);
    await m.db.query(
      `UPDATE turbines SET farm_id = 'FARM01' WHERE turbine_id = 'TURB001'`,
    );
  });

  it('creates entries with a Postgres UUID and status pending, one per (turbine, reported farm)', async () => {
    const { rows } = await insertEntry('TURB999', 'FARM01');
    expect(rows[0].id).toMatch(UUID);
    expect(rows[0].status).toBe('pending');
    // No FK on the ids: unknown turbines and farms are the point.
    await insertEntry('TURB999', 'FARM99');
    await expect(insertEntry('TURB999', 'FARM01')).rejects.toThrow(
      /unallocated_turbines_turbine_id_reported_farm_id_key/,
    );
  });

  it('holds readings once per (entry, timestamp) and deletes them with their entry', async () => {
    const { rows } = await insertEntry('TURB998', 'FARM01');
    const hold = (timestamp: string) =>
      m.db.query(
        `INSERT INTO held_telemetry (unallocated_id, turbine_id, farm_id, timestamp,
                                     power_output_kw, wind_speed_ms, rotor_rpm,
                                     blade_pitch_deg, gearbox_temp_c)
         VALUES ($1, 'TURB998', 'FARM01', $2, 1, 2, 3, 4, 5)`,
        [rows[0].id, timestamp],
      );
    await hold('2026-03-01T00:00:00Z');
    await expect(hold('2026-03-01T00:00:00Z')).rejects.toThrow(
      /held_telemetry_unallocated_id_timestamp_key/,
    );

    await m.db.query(`DELETE FROM unallocated_turbines WHERE id = $1`, [
      rows[0].id,
    ]);
    const left = await m.db.query(
      `SELECT count(*)::int AS n FROM held_telemetry`,
    );
    expect(left.rows[0].n).toBe(0);
  });

  it('keeps a blocked entry when the user who blocked it is deleted (blocked_by → null)', async () => {
    const user = await m.db.query<{ id: string }>(
      `SELECT id::text FROM users WHERE email = 'owner@nextera.local'`,
    );
    const { rows } = await insertEntry('TURB997', 'FARM01', user.rows[0].id);

    await m.db.query(`DELETE FROM users WHERE id = $1`, [user.rows[0].id]);

    const after = await m.db.query(
      `SELECT blocked_by FROM unallocated_turbines WHERE id = $1`,
      [rows[0].id],
    );
    expect(after.rows).toEqual([{ blocked_by: null }]);
  });

  it('leaves no drift between the migrated database and schema.prisma', async () => {
    await m.migrateAll();
    expect(m.diffAgainstSchema()).toContain('No difference detected');
  });
});
