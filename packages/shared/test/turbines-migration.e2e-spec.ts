import type pg from 'pg';
import { openMigrationDb, UUID, type MigrationDb } from './migration-db.js';

const TARGET = '20261006233000_turbines_uuid_id_commissioned';

/**
 * The turbines migration renames turbines.id to turbine_id and adds a UUID primary key. It is
 * hand-written because `prisma migrate diff` would drop and re-add the column, so prove that data
 * written under the previous schema survives: apply every migration before it with the real
 * `prisma migrate deploy`, insert rows with the old schema, apply it, then check the rows and that
 * the database has no drift from schema.prisma.
 */
describe(`migration ${TARGET} (e2e)`, () => {
  let m: MigrationDb;
  let db: pg.Client;

  beforeAll(async () => {
    m = await openMigrationDb(TARGET);
    db = m.db;
  });

  afterAll(async () => {
    await m?.close();
  });

  it('keeps every turbine and its telemetry, adds UUID ids and commissioned = false', async () => {
    await m.migrateBeforeTarget();

    // The previous schema: turbines.id is the business key.
    await db.query(`
      INSERT INTO farms (id, name, latitude, longitude) VALUES
        ('FARM01', 'Prairie Ridge', 41.25, -96.53),
        ('FARM02', 'High Plains', 39.74, -101.2);
      INSERT INTO turbines (id, farm_id, latitude, longitude) VALUES
        ('TURB001', 'FARM01', 41.263, -96.518),
        ('TURB002', 'FARM02', 39.741, -101.207);
      INSERT INTO telemetry (turbine_id, farm_id, timestamp, power_output_kw, wind_speed_ms,
                             rotor_rpm, blade_pitch_deg, gearbox_temp_c) VALUES
        ('TURB001', 'FARM01', '2026-01-01T13:40:00Z', 0, 15.8, 0, 90, 40),
        ('TURB001', 'FARM01', '2026-01-01T13:45:00Z', 0, 15.8, 0, 90, 40),
        ('TURB002', 'FARM02', '2026-01-02T03:20:00Z', 2200, 8.5, 13, 4, 126.5);
    `);

    expect(await m.migrateTarget()).toContain(TARGET);

    const { rows: turbines } = await db.query<{
      id: string;
      turbine_id: string;
      farm_id: string;
      latitude: string;
      commissioned: boolean;
    }>(
      'SELECT id, turbine_id, farm_id, latitude, commissioned FROM turbines ORDER BY turbine_id',
    );
    expect(turbines).toEqual([
      {
        id: expect.stringMatching(UUID),
        turbine_id: 'TURB001',
        farm_id: 'FARM01',
        latitude: '41.263000',
        commissioned: false,
      },
      {
        id: expect.stringMatching(UUID),
        turbine_id: 'TURB002',
        farm_id: 'FARM02',
        latitude: '39.741000',
        commissioned: false,
      },
    ]);
    expect(turbines[0].id).not.toBe(turbines[1].id); // one value per row

    // Telemetry still joins its turbine by (turbine_id, farm_id).
    const { rows: linked } = await db.query(`
      SELECT r.turbine_id, count(*)::int AS readings
      FROM telemetry r JOIN turbines t USING (turbine_id, farm_id)
      GROUP BY r.turbine_id ORDER BY r.turbine_id`);
    expect(linked).toEqual([
      { turbine_id: 'TURB001', readings: 2 },
      { turbine_id: 'TURB002', readings: 1 },
    ]);
  });

  it('keeps the constraints: UUID primary key, unique turbine_id, composite telemetry FK', async () => {
    const { rows: pkey } = await db.query(`
      SELECT a.attname FROM pg_index i
      JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = 'turbines'::regclass AND i.indisprimary`);
    expect(pkey).toEqual([{ attname: 'id' }]);

    await expect(
      db.query(
        `INSERT INTO turbines (turbine_id, farm_id, latitude, longitude)
         VALUES ('TURB001', 'FARM02', 1, 1)`,
      ),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'turbines_turbine_id_key',
    });

    await expect(
      db.query(`
        INSERT INTO telemetry (turbine_id, farm_id, timestamp, power_output_kw, wind_speed_ms,
                               rotor_rpm, blade_pitch_deg, gearbox_temp_c)
        VALUES ('TURB001', 'FARM02', '2026-03-01T00:00:00Z', 1, 1, 1, 1, 1)`),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'telemetry_turbine_id_farm_id_fkey',
    });

    // New turbines get a generated id and the default flag.
    const { rows: added } = await db.query(`
      INSERT INTO turbines (turbine_id, farm_id, latitude, longitude)
      VALUES ('TURB003', 'FARM02', 1, 1) RETURNING id, commissioned`);
    expect(added).toEqual([
      { id: expect.stringMatching(UUID), commissioned: false },
    ]);
  });

  it('leaves no drift between the migrated database and schema.prisma', async () => {
    // Later migrations too, so the database matches the current schema.prisma.
    await m.migrateAll();
    expect(m.diffAgainstSchema()).toContain('No difference detected');
  });
});
