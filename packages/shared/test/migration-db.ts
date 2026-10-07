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
export const SCHEMA = join(SHARED_DIR, 'prisma/schema.prisma');
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface MigrationDb {
  /** Connected to the throwaway database. */
  db: pg.Client;
  /** Runs the Prisma CLI against the throwaway database and the copied migrations. */
  prisma(...args: string[]): string;
  /** Applies every migration before `target` (with the real `prisma migrate deploy`). */
  migrateBeforeTarget(): Promise<void>;
  /** Copies `target` in and applies it; returns the CLI output. */
  migrateTarget(): Promise<string>;
  /** Applies every later migration too, so the database matches the current schema.prisma. */
  migrateAll(): Promise<void>;
  /** `prisma migrate diff` from the database to schema.prisma (throws on drift). */
  diffAgainstSchema(): string;
  close(): Promise<void>;
}

/**
 * A database of its own on the e2e server (so the shared test database is never touched), with a
 * copy of the migrations that lets a test stop just before `target`: write rows with the old
 * schema, apply `target`, and check them.
 */
export async function openMigrationDb(target: string): Promise<MigrationDb> {
  const dbName = `migration_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: inject('databaseUrl') });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${dbName}"`);
  const url = new URL(inject('databaseUrl'));
  url.pathname = `/${dbName}`;

  // Only the migrations before target at first; target and later ones are copied in on demand.
  const workDir = await mkdtemp(join(tmpdir(), 'nextera-migration-'));
  const migrations = join(workDir, 'migrations');
  const copy = (include: (name: string) => boolean) =>
    cp(MIGRATIONS_DIR, migrations, {
      recursive: true,
      filter: (src) => {
        const name = src.slice(MIGRATIONS_DIR.length + 1).split(/[/\\]/)[0];
        return name === '' || name === 'migration_lock.toml' || include(name);
      },
    });
  await copy((name) => name < target);
  const configPath = join(workDir, 'prisma.config.mjs');
  await writeFile(
    configPath,
    `export default ${JSON.stringify({
      schema: SCHEMA,
      migrations: { path: migrations },
      datasource: { url: url.toString() },
    })};\n`,
  );

  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();

  const prisma = (...args: string[]) =>
    execFileSync('npx', ['prisma', ...args, '--config', configPath], {
      cwd: SHARED_DIR,
      encoding: 'utf8',
      stdio: 'pipe',
    });

  return {
    db,
    prisma,
    async migrateBeforeTarget() {
      prisma('migrate', 'deploy');
      if ((await readdir(migrations)).includes(target)) {
        throw new Error(`${target} must not be applied yet`);
      }
    },
    async migrateTarget() {
      await copy((name) => name <= target);
      return prisma('migrate', 'deploy');
    },
    async migrateAll() {
      await copy(() => true);
      prisma('migrate', 'deploy');
    },
    // --exit-code: 0 = no difference, 2 = drift (execFileSync throws on non-zero).
    diffAgainstSchema: () =>
      prisma(
        'migrate',
        'diff',
        '--from-config-datasource',
        '--to-schema',
        SCHEMA,
        '--exit-code',
      ),
    async close() {
      await db.end();
      await admin.query(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
      await admin.end();
      await rm(workDir, { recursive: true, force: true });
    },
  };
}
