import { randomUUID } from 'node:crypto';
import { openMigrationDb, type MigrationDb } from './migration-db.js';

const TARGET = '20261104120000_scale_partitions_latest';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const iso = (t: number) => new Date(t).toISOString();
const dayOf = (t: number) => iso(t).slice(0, 10);
const partitionOf = (t: number) => `telemetry_p${dayOf(t).replaceAll('-', '')}`;
const alertsPartitionOf = (t: number) =>
  `telemetry_alerts_p${dayOf(t).replaceAll('-', '')}`;

/**
 * The scale migration: telemetry and telemetry_alerts become daily range partitions with a
 * DEFAULT partition (the old tables, attached as they are), turbine_latest is backfilled, and the
 * partition functions carve a day out of DEFAULT / drop whole days with their alerts. The previous
 * revision's writes (an alert link without reading_timestamp) keep working through the temporary
 * trigger. Prisma can't see partitions, so the no-drift check proves only the tables, columns,
 * keys and indexes Prisma models; the partitioning itself is asserted from the catalog.
 */
describe(`migration ${TARGET} (e2e)`, () => {
  let m: MigrationDb;
  const now = Date.now();
  const recent = now - HOUR; // today or yesterday, inside the 31 days
  const yesterday = now - DAY - HOUR;
  const jan = Date.UTC(2026, 0, 2, 3, 25); // outside 31 days: stays in DEFAULT
  let hotId: string; // the Jan reading with two alerts
  let recentHotId: string; // a recent reading with an error alert
  let errorRule: string;
  let warnRule: string;

  const rows = async <T = Record<string, unknown>>(
    sql: string,
    args: unknown[] = [],
  ) => (await m.db.query(sql, args)).rows as T[];

  beforeAll(async () => {
    m = await openMigrationDb(TARGET);
  });

  afterAll(async () => {
    await m?.close();
  });

  it('keeps existing readings and alerts (written with the old schema)', async () => {
    await m.migrateBeforeTarget();
    await m.db.query(`
      INSERT INTO farms (id, name, latitude, longitude) VALUES
        ('FARM01', 'Prairie Ridge', 41.25, -96.53), ('FARM02', 'Other', 42, -97);
      INSERT INTO turbines (turbine_id, farm_id, latitude, longitude)
        VALUES ('TURB001', 'FARM01', 41.263, -96.518), ('TURB002', 'FARM01', 41.27, -96.5);
      INSERT INTO alerts_config (measurement_metric, comparison, value_metric, alert_level)
        VALUES ('gearbox_temp_c', 'above', 120, 'error'), ('gearbox_temp_c', 'above', 90, 'warn');`);
    for (const [turbine, at, gearbox] of [
      ['TURB001', jan, 126.5],
      ['TURB001', jan + 300_000, 80],
      ['TURB001', yesterday, 70],
      ['TURB001', recent, 130],
      ['TURB002', recent, 60],
    ] as const) {
      await m.db.query(
        `INSERT INTO telemetry (turbine_id, farm_id, timestamp, power_output_kw, wind_speed_ms,
                                rotor_rpm, blade_pitch_deg, gearbox_temp_c)
         VALUES ($1, 'FARM01', $2, 2200, 8.5, 13, 4, $3)`,
        [turbine, iso(at), gearbox],
      );
    }
    const rules = await rows<{ id: string; alert_level: string }>(
      'SELECT id, alert_level FROM alerts_config',
    );
    errorRule = rules.find((r) => r.alert_level === 'error')!.id;
    warnRule = rules.find((r) => r.alert_level === 'warn')!.id;
    hotId = (
      await rows<{ id: string }>(
        'SELECT id FROM telemetry WHERE timestamp = $1',
        [iso(jan)],
      )
    )[0].id;
    recentHotId = (
      await rows<{ id: string }>(
        `SELECT id FROM telemetry WHERE turbine_id = 'TURB001' AND timestamp = $1`,
        [iso(recent)],
      )
    )[0].id;
    await m.db.query(
      `INSERT INTO telemetry_alerts (telemetry_id, alert_id) VALUES ($1, $2), ($1, $3), ($4, $2)`,
      [hotId, errorRule, warnRule, recentHotId],
    );
    const before = await rows<{ id: string; created_at: Date }>(
      'SELECT id, created_at FROM telemetry ORDER BY timestamp, turbine_id',
    );

    expect(await m.migrateTarget()).toContain(TARGET);

    const after = await rows<{ id: string; created_at: Date }>(
      'SELECT id, created_at FROM telemetry ORDER BY timestamp, turbine_id',
    );
    expect(after).toEqual(before); // every reading, same ids and insert times
    const alerts = await rows(
      `SELECT telemetry_id, reading_timestamp, alert_id FROM telemetry_alerts
       ORDER BY reading_timestamp, alert_id`,
    );
    expect(alerts).toHaveLength(3);
    expect(
      alerts.map((a) => (a.reading_timestamp as Date).getTime()).sort(),
    ).toEqual([jan, jan, recent].sort());
  });

  it('is partitioned: recent days in daily partitions, older rows in the DEFAULT partitions', async () => {
    expect(
      await rows(
        `SELECT c.relname FROM pg_partitioned_table p JOIN pg_class c ON c.oid = p.partrelid
         ORDER BY 1`,
      ),
    ).toEqual([{ relname: 'telemetry' }, { relname: 'telemetry_alerts' }]);

    const where = await rows<{ part: string; at: Date }>(
      'SELECT tableoid::regclass::text AS part, timestamp AS at FROM telemetry ORDER BY timestamp',
    );
    expect(where.map((r) => r.part)).toEqual([
      'telemetry_default', // 2026-01-02, outside the last 31 days
      'telemetry_default',
      partitionOf(yesterday),
      partitionOf(recent),
      partitionOf(recent),
    ]);
    // The alerts follow their readings.
    const alertParts = await rows<{ part: string; reading_timestamp: Date }>(
      `SELECT tableoid::regclass::text AS part, reading_timestamp FROM telemetry_alerts
       ORDER BY reading_timestamp`,
    );
    expect(alertParts.map((a) => a.part)).toEqual([
      'telemetry_alerts_default',
      'telemetry_alerts_default',
      alertsPartitionOf(recent),
    ]);
    // Partitions ahead: today through +3 days.
    for (let d = 0; d <= 3; d++) {
      expect(
        (
          await rows(`SELECT to_regclass('${partitionOf(now + d * DAY)}') AS t`)
        )[0].t,
      ).not.toBeNull();
    }
  });

  it('backfills turbine_latest with each turbine’s newest reading and its worst alert level', async () => {
    const latest = await rows<{
      turbine_id: string;
      timestamp: Date;
      worst_alert_level: string | null;
      reading_id: string;
    }>('SELECT * FROM turbine_latest ORDER BY turbine_id');
    expect(latest.map((l) => [l.turbine_id, l.worst_alert_level])).toEqual([
      ['TURB001', 'error'], // its newest reading triggered the error rule
      ['TURB002', null],
    ]);
    expect(latest[0].reading_id).toBe(recentHotId);
    expect(latest[0].timestamp.toISOString()).toBe(iso(recent));
  });

  it('keeps the keys: (turbine, timestamp) unique, a reading needs its turbine, alerts need their reading', async () => {
    await expect(
      m.db.query(
        `INSERT INTO telemetry (turbine_id, farm_id, timestamp, power_output_kw, wind_speed_ms,
                                rotor_rpm, blade_pitch_deg, gearbox_temp_c)
         VALUES ('TURB001', 'FARM01', $1, 1, 1, 1, 1, 1)`,
        [iso(jan)],
      ),
    ).rejects.toMatchObject({ code: '23505' });
    // ON CONFLICT DO NOTHING (what ingestion's skipDuplicates sends) works on the partitioned table.
    const dup = await m.db.query(
      `INSERT INTO telemetry (turbine_id, farm_id, timestamp, power_output_kw, wind_speed_ms,
                              rotor_rpm, blade_pitch_deg, gearbox_temp_c)
       VALUES ('TURB001', 'FARM01', $1, 1, 1, 1, 1, 1) ON CONFLICT DO NOTHING`,
      [iso(jan)],
    );
    expect(dup.rowCount).toBe(0);
    await expect(
      m.db.query(
        `INSERT INTO telemetry (turbine_id, farm_id, timestamp, power_output_kw, wind_speed_ms,
                                rotor_rpm, blade_pitch_deg, gearbox_temp_c)
         VALUES ('TURB001', 'FARM02', $1, 1, 1, 1, 1, 1)`,
        [iso(now - 3 * HOUR)],
      ),
    ).rejects.toMatchObject({ code: '23503' }); // not the turbine's farm
    await expect(
      m.db.query(
        `INSERT INTO telemetry_alerts (telemetry_id, reading_timestamp, alert_id) VALUES ($1, $2, $3)`,
        [randomUUID(), iso(recent), errorRule],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    // A rule that fired can't be deleted (RESTRICT).
    await expect(
      m.db.query('DELETE FROM alerts_config WHERE id = $1', [errorRule]),
    ).rejects.toMatchObject({ code: '23001' });
  });

  it('keeps the previous revision working: an alert link without reading_timestamp lands in the right partition', async () => {
    const fresh = await rows<{ id: string }>(
      `INSERT INTO telemetry (turbine_id, farm_id, timestamp, power_output_kw, wind_speed_ms,
                              rotor_rpm, blade_pitch_deg, gearbox_temp_c)
       VALUES ('TURB002', 'FARM01', $1, 2200, 8, 13, 4, 125) RETURNING id`,
      [iso(now - 2 * HOUR)],
    );
    // Exactly what the old revision sends (Prisma createMany): no reading_timestamp.
    const inserted = await m.db.query(
      'INSERT INTO telemetry_alerts (telemetry_id, alert_id) VALUES ($1, $2)',
      [fresh[0].id, errorRule],
    );
    expect(inserted.rowCount).toBe(0); // the placeholder row is not stored; the trigger re-inserts it

    const link = await rows<{ part: string; reading_timestamp: Date }>(
      `SELECT tableoid::regclass::text AS part, reading_timestamp FROM telemetry_alerts
       WHERE telemetry_id = $1`,
      [fresh[0].id],
    );
    expect(link).toHaveLength(1);
    expect(link[0].part).toBe(alertsPartitionOf(now - 2 * HOUR));
    expect(link[0].reading_timestamp.toISOString()).toBe(iso(now - 2 * HOUR));
    // An unknown reading is still a foreign key violation.
    await expect(
      m.db.query(
        'INSERT INTO telemetry_alerts (telemetry_id, alert_id) VALUES ($1, $2)',
        [randomUUID(), errorRule],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('a move carries the readings, the latest row and keeps the alerts', async () => {
    await m.db.query(
      `UPDATE turbines SET farm_id = 'FARM02' WHERE turbine_id = 'TURB002'`,
    );
    expect(
      await rows(
        `SELECT DISTINCT farm_id FROM telemetry WHERE turbine_id = 'TURB002'`,
      ),
    ).toEqual([{ farm_id: 'FARM02' }]);
    expect(
      await rows(
        `SELECT farm_id FROM turbine_latest WHERE turbine_id = 'TURB002'`,
      ),
    ).toEqual([{ farm_id: 'FARM02' }]);
    expect(
      (
        await rows<{ n: number }>(
          `SELECT count(*)::int AS n FROM telemetry_alerts a JOIN telemetry t
           ON t.id = a.telemetry_id AND t.timestamp = a.reading_timestamp
         WHERE t.turbine_id = 'TURB002'`,
        )
      )[0].n,
    ).toBe(1);
    await m.db.query(
      `UPDATE turbines SET farm_id = 'FARM01' WHERE turbine_id = 'TURB002'`,
    );
  });

  it('telemetry_ensure_partition moves a day out of DEFAULT with its alerts; a second call does nothing', async () => {
    const day = dayOf(jan);
    expect(
      (
        await rows<{ c: boolean }>(
          `SELECT telemetry_ensure_partition($1::date) AS c`,
          [day],
        )
      )[0].c,
    ).toBe(true);

    const where = await rows<{ part: string }>(
      `SELECT DISTINCT tableoid::regclass::text AS part FROM telemetry WHERE timestamp < $1`,
      [iso(jan + DAY)],
    );
    expect(where).toEqual([{ part: partitionOf(jan) }]);
    expect(
      await rows<{ part: string; n: number }>(
        `SELECT tableoid::regclass::text AS part, count(*)::int AS n FROM telemetry_alerts
         WHERE reading_timestamp < $1 GROUP BY 1`,
        [iso(jan + DAY)],
      ),
    ).toEqual([{ part: alertsPartitionOf(jan), n: 2 }]);
    // Both alerts still hang off their reading.
    expect(
      (
        await rows<{ n: number }>(
          `SELECT count(*)::int AS n FROM telemetry_alerts a JOIN telemetry t
           ON t.id = a.telemetry_id AND t.timestamp = a.reading_timestamp WHERE t.id = $1`,
          [hotId],
        )
      )[0].n,
    ).toBe(2);
    expect(
      (
        await rows<{ c: boolean }>(
          `SELECT telemetry_ensure_partition($1::date) AS c`,
          [day],
        )
      )[0].c,
    ).toBe(false);
    expect(
      (
        await rows<{ n: number }>(
          'SELECT count(*)::int AS n FROM telemetry_default',
        )
      )[0].n,
    ).toBe(0);
  });

  it('telemetry_drop_partitions_before drops a day’s readings and alerts together and nothing else', async () => {
    const before = (
      await rows<{ n: number }>('SELECT count(*)::int AS n FROM telemetry')
    )[0].n;
    const dropped = await rows<{ d: number }>(
      `SELECT telemetry_drop_partitions_before($1::date) AS d`,
      [dayOf(now - 30 * DAY)],
    );
    expect(dropped[0].d).toBe(1); // only 2026-01-02
    expect(
      (await rows<{ n: number }>('SELECT count(*)::int AS n FROM telemetry'))[0]
        .n,
    ).toBe(before - 2);
    expect(
      await rows(`SELECT to_regclass('${alertsPartitionOf(jan)}') AS t`),
    ).toEqual([{ t: null }]);
    // The dropped reading's alerts are gone; the recent ones, the rules and turbines are intact.
    expect(
      (
        await rows<{ n: number }>(
          `SELECT count(*)::int AS n FROM telemetry_alerts WHERE telemetry_id = $1`,
          [hotId],
        )
      )[0].n,
    ).toBe(0);
    expect(
      (
        await rows<{ n: number }>(
          `SELECT count(*)::int AS n FROM telemetry_alerts WHERE telemetry_id = $1`,
          [recentHotId],
        )
      )[0].n,
    ).toBe(1);
    expect(
      (
        await rows<{ n: number }>(
          'SELECT count(*)::int AS n FROM alerts_config',
        )
      )[0].n,
    ).toBe(2);
    expect(
      (await rows<{ n: number }>('SELECT count(*)::int AS n FROM turbines'))[0]
        .n,
    ).toBe(2);
    // The rule that fired only on dropped readings... warnRule had only the Jan reading: deletable now.
    await m.db.query('DELETE FROM alerts_config WHERE id = $1', [warnRule]);
  });

  it('leaves no drift between the migrated database and schema.prisma', async () => {
    await m.migrateAll();
    expect(m.diffAgainstSchema()).toContain('No difference detected');
  });
});
