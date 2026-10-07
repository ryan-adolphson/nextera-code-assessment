import { openMigrationDb, type MigrationDb } from './migration-db.js';

const TARGET = '20261007040000_telemetry_created_at';

/**
 * Adds telemetry.created_at (insert time, default now()). Prove it is backward-compatible:
 * existing readings survive and get a created_at (the migration time), inserts that don't name the
 * column (the running revision) get now(), and the database has no drift from schema.prisma.
 */
describe(`migration ${TARGET} (e2e)`, () => {
  let m: MigrationDb;

  beforeAll(async () => {
    m = await openMigrationDb(TARGET);
  });

  afterAll(async () => {
    await m?.close();
  });

  const insertReading = (timestamp: string, receivedAt: string) =>
    m.db.query(
      `INSERT INTO telemetry (turbine_id, farm_id, timestamp, received_at, power_output_kw,
                              wind_speed_ms, rotor_rpm, blade_pitch_deg, gearbox_temp_c)
       VALUES ('TURB001', 'FARM01', $1, $2, 2200, 8.5, 13, 4, 80)`,
      [timestamp, receivedAt],
    );

  it('keeps existing readings and gives them the migration time as created_at', async () => {
    await m.migrateBeforeTarget();
    await m.db.query(`
      INSERT INTO farms (id, name, latitude, longitude) VALUES ('FARM01', 'Prairie Ridge', 41.25, -96.53);
      INSERT INTO turbines (turbine_id, farm_id, latitude, longitude)
        VALUES ('TURB001', 'FARM01', 41.263, -96.518);
    `);
    await insertReading('2026-01-02T03:25:00Z', '2026-01-02T03:27:00Z');

    const before = Date.now();
    expect(await m.migrateTarget()).toContain(TARGET);

    const { rows } = await m.db.query<{
      received_at: Date;
      created_at: Date;
    }>('SELECT received_at, created_at FROM telemetry');
    expect(rows).toHaveLength(1);
    expect(rows[0].received_at).toEqual(new Date('2026-01-02T03:27:00Z'));
    expect(rows[0].created_at.getTime()).toBeGreaterThanOrEqual(before - 1000);
  });

  it('defaults created_at to now() for inserts that do not name it, independent of received_at', async () => {
    // A backfill: measured and "received" weeks ago, inserted now.
    await insertReading('2026-01-02T03:30:00Z', '2026-01-02T03:31:00Z');
    const { rows } = await m.db.query<{ created_at: Date; now: Date }>(
      `SELECT created_at, now() AS now FROM telemetry
       WHERE timestamp = '2026-01-02T03:30:00Z'`,
    );
    expect(
      Math.abs(rows[0].created_at.getTime() - rows[0].now.getTime()),
    ).toBeLessThan(5_000);

    const { rows: column } = await m.db.query(`
      SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'telemetry' AND column_name = 'created_at'`);
    expect(column).toEqual([
      { is_nullable: 'NO', column_default: 'CURRENT_TIMESTAMP' },
    ]);
  });

  it('leaves no drift between the migrated database and schema.prisma', async () => {
    await m.migrateAll();
    expect(m.diffAgainstSchema()).toContain('No difference detected');
  });
});
