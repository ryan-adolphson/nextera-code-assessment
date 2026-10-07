import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cp, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

const SHARED_DIR = fileURLToPath(new URL('..', import.meta.url));
const MIGRATIONS_DIR = join(SHARED_DIR, 'prisma/migrations');
const SCHEMA = join(SHARED_DIR, 'prisma/schema.prisma');
const TARGET = '20261007010000_alert_history';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The alert_history migration adds alerts_config.enabled and the alert_history table. Prove it is
 * backward-compatible: rules written under the previous schema survive (enabled), an insert
 * without `enabled` (the running revision) still works, history rows get their defaults, both
 * foreign keys hold and RESTRICT keeps history, and the database has no drift from schema.prisma.
 */
describe(`migration ${TARGET} (e2e)`, () => {
  const dbName = `migration_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Client;
  let db: pg.Client;
  let workDir: string;
  let configPath: string;
  let turbineId: string;
  let ruleId: string;

  /** Runs the Prisma CLI against the throwaway database and the copied migrations. */
  const prisma = (...args: string[]) =>
    execFileSync('npx', ['prisma', ...args, '--config', configPath], {
      cwd: SHARED_DIR,
      encoding: 'utf8',
      stdio: 'pipe',
    });

  beforeAll(async () => {
    // A database of its own on the e2e server, so the shared test database is never touched.
    admin = new pg.Client({ connectionString: inject('databaseUrl') });
    await admin.connect();
    await admin.query(`CREATE DATABASE "${dbName}"`);
    const url = new URL(inject('databaseUrl'));
    url.pathname = `/${dbName}`;

    // Only the migrations before TARGET at first; TARGET is copied in later.
    workDir = await mkdtemp(join(tmpdir(), 'nextera-migration-'));
    const migrations = join(workDir, 'migrations');
    await cp(MIGRATIONS_DIR, migrations, {
      recursive: true,
      filter: (src) => {
        const name = src.slice(MIGRATIONS_DIR.length + 1).split(/[/\\]/)[0];
        return name === '' || name === 'migration_lock.toml' || name < TARGET;
      },
    });
    configPath = join(workDir, 'prisma.config.mjs');
    await writeFile(
      configPath,
      `export default ${JSON.stringify({
        schema: SCHEMA,
        migrations: { path: migrations },
        datasource: { url: url.toString() },
      })};\n`,
    );

    db = new pg.Client({ connectionString: url.toString() });
    await db.connect();
  });

  afterAll(async () => {
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
    await admin?.end();
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it('keeps every rule (enabled) and still accepts inserts without enabled', async () => {
    prisma('migrate', 'deploy');
    expect(await readdir(join(workDir, 'migrations'))).not.toContain(TARGET);

    // The previous schema: no enabled column, no alert_history.
    await db.query(`
      INSERT INTO farms (id, name, latitude, longitude) VALUES ('FARM01', 'Prairie Ridge', 41.25, -96.53);
      INSERT INTO turbines (turbine_id, farm_id, latitude, longitude)
        VALUES ('TURB001', 'FARM01', 41.263, -96.518);
      INSERT INTO alerts_config (measurement_metric, comparison, value_metric, alert_level)
        VALUES ('gearbox_temp_c', 'above', 120, 'error');
    `);

    await cp(
      join(MIGRATIONS_DIR, TARGET),
      join(workDir, 'migrations', TARGET),
      { recursive: true },
    );
    expect(prisma('migrate', 'deploy')).toContain(TARGET);

    const { rows: rules } = await db.query<{
      id: string;
      value_metric: number;
      enabled: boolean;
    }>('SELECT id, value_metric, enabled FROM alerts_config');
    expect(rules).toEqual([
      { id: expect.stringMatching(UUID), value_metric: 120, enabled: true },
    ]);
    ruleId = rules[0].id;
    turbineId = (
      await db.query<{ id: string }>(
        `SELECT id FROM turbines WHERE turbine_id = 'TURB001'`,
      )
    ).rows[0].id;

    // The running API revision inserts without `enabled`: it defaults to true.
    const { rows: added } = await db.query(`
      INSERT INTO alerts_config (measurement_metric, comparison, value_metric, alert_level)
      VALUES ('wind_speed_ms', 'above', 25, 'warn') RETURNING enabled`);
    expect(added).toEqual([{ enabled: true }]);
  });

  it('creates alert history rows with a generated id, timestamps defaulting to now and resolved_at null', async () => {
    const { rows } = await db.query<{
      id: string;
      turbine_id: string;
      alert_id: string;
      created_at: Date;
      updated_at: Date;
      resolved_at: Date | null;
      now: Date;
    }>(
      `INSERT INTO alert_history (turbine_id, alert_id) VALUES ($1, $2)
       RETURNING *, now() AS now`,
      [turbineId, ruleId],
    );
    const [{ now, ...row }] = rows;
    expect(row).toEqual({
      id: expect.stringMatching(UUID),
      turbine_id: turbineId,
      alert_id: ruleId,
      created_at: expect.any(Date),
      updated_at: row.created_at,
      resolved_at: null,
    });
    // now(), rounded to the column's millisecond precision.
    expect(
      Math.abs(row.created_at.getTime() - now.getTime()),
    ).toBeLessThanOrEqual(1);
  });

  it('references turbines.id and alerts_config.id', async () => {
    const insert = (turbine: string, alert: string) =>
      db.query(
        'INSERT INTO alert_history (turbine_id, alert_id) VALUES ($1, $2)',
        [turbine, alert],
      );
    await expect(insert(randomUUID(), ruleId)).rejects.toMatchObject({
      code: '23503',
      constraint: 'alert_history_turbine_id_fkey',
    });
    await expect(insert(turbineId, randomUUID())).rejects.toMatchObject({
      code: '23503',
      constraint: 'alert_history_alert_id_fkey',
    });
  });

  it('keeps history: a rule or turbine with history cannot be deleted (RESTRICT), one without can', async () => {
    // ON DELETE RESTRICT raises restrict_violation (23001), not foreign_key_violation (23503).
    await expect(
      db.query('DELETE FROM alerts_config WHERE id = $1', [ruleId]),
    ).rejects.toMatchObject({
      code: '23001',
      constraint: 'alert_history_alert_id_fkey',
    });
    await expect(
      db.query('DELETE FROM turbines WHERE id = $1', [turbineId]),
    ).rejects.toMatchObject({
      code: '23001',
      constraint: 'alert_history_turbine_id_fkey',
    });

    // Disabling is the way to retire a rule with history.
    const { rows: disabled } = await db.query(
      'UPDATE alerts_config SET enabled = false WHERE id = $1 RETURNING enabled',
      [ruleId],
    );
    expect(disabled).toEqual([{ enabled: false }]);

    const { rowCount } = await db.query(
      `DELETE FROM alerts_config WHERE measurement_metric = 'wind_speed_ms'`,
    );
    expect(rowCount).toBe(1);
  });

  it('leaves no drift between the migrated database and schema.prisma', async () => {
    // Later migrations too, so the database matches the current schema.prisma.
    await cp(MIGRATIONS_DIR, join(workDir, 'migrations'), { recursive: true });
    prisma('migrate', 'deploy');
    // --exit-code: 0 = no difference, 2 = drift (execFileSync throws on non-zero).
    expect(
      prisma(
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        SCHEMA,
        '--exit-code',
      ),
    ).toContain('No difference detected');
  });
});
