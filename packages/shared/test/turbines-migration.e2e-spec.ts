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
const TARGET = '20261006233000_turbines_uuid_id_commissioned';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * The turbines migration renames turbines.id to turbine_id and adds a UUID primary key. It is
 * hand-written because `prisma migrate diff` would drop and re-add the column, so prove that data
 * written under the previous schema survives: apply every migration before it with the real
 * `prisma migrate deploy`, insert rows with the old schema, apply it, then check the rows and that
 * the database has no drift from schema.prisma.
 */
describe(`migration ${TARGET} (e2e)`, () => {
  const dbName = `migration_${randomUUID().replaceAll('-', '')}`;
  let admin: pg.Client;
  let db: pg.Client;
  let workDir: string;
  let configPath: string;

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

  it('keeps every turbine and its telemetry, adds UUID ids and commissioned = false', async () => {
    prisma('migrate', 'deploy');
    expect(await readdir(join(workDir, 'migrations'))).not.toContain(TARGET);

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

    await cp(
      join(MIGRATIONS_DIR, TARGET),
      join(workDir, 'migrations', TARGET),
      {
        recursive: true,
      },
    );
    expect(prisma('migrate', 'deploy')).toContain(TARGET);

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
