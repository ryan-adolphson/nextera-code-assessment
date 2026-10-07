import { randomUUID } from 'node:crypto';
import { openMigrationDb, type MigrationDb } from './migration-db.js';

const TARGET = '20261007020000_telemetry_alerts';

/**
 * The telemetry_alerts migration adds the join table between telemetry and alerts_config. Prove it
 * is backward-compatible (existing readings and rules survive untouched), that both foreign keys
 * hold, that deleting a reading removes its rows (CASCADE) while a rule that fired cannot be
 * deleted (RESTRICT), and that the database has no drift from schema.prisma.
 */
describe(`migration ${TARGET} (e2e)`, () => {
  let m: MigrationDb;
  let readingId: string;
  let ruleId: string;

  beforeAll(async () => {
    m = await openMigrationDb(TARGET);
  });

  afterAll(async () => {
    await m?.close();
  });

  it('keeps existing readings and rules', async () => {
    await m.migrateBeforeTarget();
    await m.db.query(`
      INSERT INTO farms (id, name, latitude, longitude) VALUES ('FARM01', 'Prairie Ridge', 41.25, -96.53);
      INSERT INTO turbines (turbine_id, farm_id, latitude, longitude)
        VALUES ('TURB001', 'FARM01', 41.263, -96.518);
      INSERT INTO telemetry (turbine_id, farm_id, timestamp, power_output_kw, wind_speed_ms,
                             rotor_rpm, blade_pitch_deg, gearbox_temp_c)
        VALUES ('TURB001', 'FARM01', '2026-01-02T03:25:00Z', 2200, 8.5, 13, 4, 126.5),
               ('TURB001', 'FARM01', '2026-01-02T03:30:00Z', 2200, 8.5, 13, 4, 80);
      INSERT INTO alerts_config (measurement_metric, comparison, value_metric, alert_level)
        VALUES ('gearbox_temp_c', 'above', 120, 'error');
    `);

    expect(await m.migrateTarget()).toContain(TARGET);

    const { rows: readings } = await m.db.query<{
      id: string;
      gearbox_temp_c: number;
    }>('SELECT id, gearbox_temp_c FROM telemetry ORDER BY timestamp');
    expect(readings.map((r) => r.gearbox_temp_c)).toEqual([126.5, 80]);
    readingId = readings[0].id;
    ruleId = (await m.db.query<{ id: string }>('SELECT id FROM alerts_config'))
      .rows[0].id;
    // Readings stored before the migration have no alerts (no backfill).
    const { rows: count } = await m.db.query(
      'SELECT count(*)::int AS n FROM telemetry_alerts',
    );
    expect(count).toEqual([{ n: 0 }]);
  });

  it('links a reading to N rules, at most once each, and joins back to the rule', async () => {
    const { rows: warn } = await m.db.query<{ id: string }>(`
      INSERT INTO alerts_config (measurement_metric, comparison, value_metric, alert_level)
      VALUES ('gearbox_temp_c', 'above', 90, 'warn') RETURNING id`);
    await m.db.query(
      'INSERT INTO telemetry_alerts (telemetry_id, alert_id) VALUES ($1, $2), ($1, $3)',
      [readingId, ruleId, warn[0].id],
    );

    const { rows } = await m.db.query(
      `SELECT a.alert_level, a.value_metric
       FROM telemetry_alerts ta JOIN alerts_config a ON a.id = ta.alert_id
       WHERE ta.telemetry_id = $1 ORDER BY a.value_metric`,
      [readingId],
    );
    expect(rows).toEqual([
      { alert_level: 'warn', value_metric: 90 },
      { alert_level: 'error', value_metric: 120 },
    ]);

    await expect(
      m.db.query(
        'INSERT INTO telemetry_alerts (telemetry_id, alert_id) VALUES ($1, $2)',
        [readingId, ruleId],
      ),
    ).rejects.toMatchObject({
      code: '23505',
      constraint: 'telemetry_alerts_pkey',
    });
  });

  it('references telemetry.id and alerts_config.id', async () => {
    const insert = (telemetryId: string, alertId: string) =>
      m.db.query(
        'INSERT INTO telemetry_alerts (telemetry_id, alert_id) VALUES ($1, $2)',
        [telemetryId, alertId],
      );
    await expect(insert(randomUUID(), ruleId)).rejects.toMatchObject({
      code: '23503',
      constraint: 'telemetry_alerts_telemetry_id_fkey',
    });
    await expect(insert(readingId, randomUUID())).rejects.toMatchObject({
      code: '23503',
      constraint: 'telemetry_alerts_alert_id_fkey',
    });
  });

  it('keeps a rule that fired (RESTRICT) and drops the rows of a deleted reading (CASCADE)', async () => {
    // ON DELETE RESTRICT raises restrict_violation (23001).
    await expect(
      m.db.query('DELETE FROM alerts_config WHERE id = $1', [ruleId]),
    ).rejects.toMatchObject({
      code: '23001',
      constraint: 'telemetry_alerts_alert_id_fkey',
    });

    await m.db.query('DELETE FROM telemetry WHERE id = $1', [readingId]);
    const { rows } = await m.db.query(
      'SELECT count(*)::int AS n FROM telemetry_alerts',
    );
    expect(rows).toEqual([{ n: 0 }]);
    // With its readings gone, the rule can be deleted.
    await m.db.query('DELETE FROM alerts_config WHERE id = $1', [ruleId]);
  });

  it('leaves no drift between the migrated database and schema.prisma', async () => {
    await m.migrateAll();
    expect(m.diffAgainstSchema()).toContain('No difference detected');
  });
});
