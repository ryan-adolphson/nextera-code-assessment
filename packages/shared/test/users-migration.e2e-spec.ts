import { openMigrationDb, UUID, type MigrationDb } from './migration-db.js';

const TARGET = '20261007050000_users';

/**
 * Adds the `role` enum and the `users` table. Expand-only, so prove it: existing fleet data survives,
 * the running revision's writes (which never name users) keep working, the new table has its
 * defaults and constraints, and the database has no drift from schema.prisma.
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

  it('keeps existing farms, turbines, telemetry and alert rules', async () => {
    await m.migrateBeforeTarget();
    await m.db.query(`
      INSERT INTO farms (id, name, latitude, longitude) VALUES ('FARM01', 'Prairie Ridge', 41.25, -96.53);
      INSERT INTO turbines (turbine_id, farm_id, latitude, longitude)
        VALUES ('TURB001', 'FARM01', 41.263, -96.518);
      INSERT INTO alerts_config (measurement_metric, comparison, value_metric, alert_level)
        VALUES ('gearbox_temp_c', 'above', 120, 'error');
    `);
    await insertReading('2026-01-02T03:25:00Z');

    expect(await m.migrateTarget()).toContain(TARGET);

    const { rows } = await m.db.query(`
      SELECT (SELECT count(*) FROM farms)::int AS farms,
             (SELECT count(*) FROM turbines)::int AS turbines,
             (SELECT count(*) FROM telemetry)::int AS telemetry,
             (SELECT count(*) FROM alerts_config)::int AS rules,
             (SELECT count(*) FROM users)::int AS users`);
    expect(rows[0]).toEqual({
      farms: 1,
      turbines: 1,
      telemetry: 1,
      rules: 1,
      users: 0,
    });
    // The running revision's inserts are unaffected.
    await insertReading('2026-01-02T03:30:00Z');
  });

  it('creates users with a Postgres UUID, active = true and timestamps by default', async () => {
    const { rows } = await m.db.query(`
      INSERT INTO users (email, password_hash, role)
      VALUES ('viewer@nextera.local', '$argon2id$v=19$m=19456,t=2,p=1$x$y', 'viewer')
      RETURNING id::text, role::text, active, created_at, updated_at`);
    expect(rows[0]).toMatchObject({ role: 'viewer', active: true });
    expect(rows[0].id).toMatch(UUID);
    expect(rows[0].created_at).toBeInstanceOf(Date);
    expect(rows[0].updated_at).toBeInstanceOf(Date);
  });

  it('rejects a duplicate email and an unknown role', async () => {
    await expect(
      m.db.query(`
        INSERT INTO users (email, password_hash, role)
        VALUES ('viewer@nextera.local', 'h', 'owner')`),
    ).rejects.toThrow(/users_email_key/);
    await expect(
      m.db.query(`
        INSERT INTO users (email, password_hash, role)
        VALUES ('operator@nextera.local', 'h', 'operator')`),
    ).rejects.toThrow(/invalid input value for enum role/);
  });

  it('leaves no drift between the migrated database and schema.prisma', async () => {
    await m.migrateAll();
    expect(m.diffAgainstSchema()).toContain('No difference detected');
  });
});
