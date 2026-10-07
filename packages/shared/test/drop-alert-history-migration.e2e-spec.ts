import { openMigrationDb, type MigrationDb } from './migration-db.js';

const TARGET = '20261007030000_drop_alert_history';

/**
 * Drops alert_history (nothing wrote to it; telemetry_alerts records which rules each reading
 * triggered). Prove only that table goes: readings, rules and their telemetry_alerts survive, a
 * rule that fired is still protected from deletion, and the database has no drift from
 * schema.prisma.
 */
describe(`migration ${TARGET} (e2e)`, () => {
  let m: MigrationDb;

  beforeAll(async () => {
    m = await openMigrationDb(TARGET);
  });

  afterAll(async () => {
    await m?.close();
  });

  const exists = async (table: string) =>
    (
      await m.db.query<{ t: string | null }>('SELECT to_regclass($1) AS t', [
        table,
      ])
    ).rows[0].t !== null;

  it('drops alert_history (with its rows) and keeps everything else', async () => {
    await m.migrateBeforeTarget();
    await m.db.query(`
      INSERT INTO farms (id, name, latitude, longitude) VALUES ('FARM01', 'Prairie Ridge', 41.25, -96.53);
      INSERT INTO turbines (turbine_id, farm_id, latitude, longitude)
        VALUES ('TURB001', 'FARM01', 41.263, -96.518);
      INSERT INTO telemetry (turbine_id, farm_id, timestamp, power_output_kw, wind_speed_ms,
                             rotor_rpm, blade_pitch_deg, gearbox_temp_c)
        VALUES ('TURB001', 'FARM01', '2026-01-02T03:25:00Z', 2200, 8.5, 13, 4, 126.5);
      INSERT INTO alerts_config (measurement_metric, comparison, value_metric, alert_level, enabled)
        VALUES ('gearbox_temp_c', 'above', 120, 'error', false);
      INSERT INTO telemetry_alerts (telemetry_id, alert_id)
        SELECT t.id, a.id FROM telemetry t, alerts_config a;
      INSERT INTO alert_history (turbine_id, alert_id)
        SELECT t.id, a.id FROM turbines t, alerts_config a;
    `);
    expect(await exists('alert_history')).toBe(true);

    expect(await m.migrateTarget()).toContain(TARGET);

    expect(await exists('alert_history')).toBe(false);
    const { rows } = await m.db.query(`
      SELECT (SELECT count(*)::int FROM telemetry) AS readings,
             (SELECT count(*)::int FROM telemetry_alerts) AS links,
             (SELECT enabled FROM alerts_config) AS enabled`);
    expect(rows).toEqual([{ readings: 1, links: 1, enabled: false }]);
  });

  it('still protects a rule that readings triggered (telemetry_alerts RESTRICT)', async () => {
    await expect(m.db.query('DELETE FROM alerts_config')).rejects.toMatchObject(
      {
        code: '23001',
        constraint: 'telemetry_alerts_alert_id_fkey',
      },
    );
    // Turbines are no longer referenced by alert history (their telemetry still guards them).
    await expect(m.db.query('DELETE FROM turbines')).rejects.toMatchObject({
      constraint: 'telemetry_turbine_id_farm_id_fkey',
    });
  });

  it('leaves no drift between the migrated database and schema.prisma', async () => {
    await m.migrateAll();
    expect(m.diffAgainstSchema()).toContain('No difference detected');
  });
});
