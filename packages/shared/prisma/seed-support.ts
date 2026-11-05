import { config } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import argon2 from 'argon2';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PASSWORD_HASH_OPTIONS } from '../src/auth/passwords.js';
import { SEED_USERS, seedUsers } from '../src/seed/seed-users.js';
import { runAnomalyRollup } from '../src/wind/anomaly-rollup.js';
import { runFarmRollup } from '../src/wind/farm-rollup.js';
import { runLiveSummary } from '../src/wind/live-summary.js';

/** Shared by `npm run db:seed` (seed.ts) and `npm run db:seed:demo` (seed-demo.ts). */

// One .env at the repo root; real environment variables win.
config({ path: ['.env', '../../.env'], quiet: true });

/** The fixture CSVs (prisma/data). */
export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');

/** Creates or resets the SEED_USERS with SEED_USER_PASSWORD (argon2id); throws without one. */
export function seedTestUsers(prisma: PrismaClient): Promise<number> {
  return seedUsers(prisma, process.env.SEED_USER_PASSWORD, (pw) =>
    argon2.hash(pw, PASSWORD_HASH_OPTIONS),
  );
}

/**
 * What is derived from the readings, brought up to date after a seed, so the web app and the
 * Playwright fixture have it at once:
 *   - one farm rollup run (the farms' daily history): incremental, the first run on a database is
 *     full; skipped if another run (the compose farm-rollup service) holds the lock;
 *   - the live summaries (`farm_live_summary`, as of now), which the live-summary job keeps fresh;
 *   - one anomaly rollup run (`anomaly_episodes`) as of the end of the data (the fixture ends in
 *     January 2026, the demo at now); the first run looks 7 days back.
 * turbine_latest needs no step: the seeds write it with the readings.
 */
export async function rollupAfterSeed(prisma: PrismaClient): Promise<string> {
  const started = Date.now();
  const r = await runFarmRollup(prisma);
  const farmRollup = r.skipped
    ? 'farm rollup skipped (another run holds the lock),'
    : `farm rollup: ${r.written} rows for ${r.farms} farms in ${Date.now() - started} ms,`;

  const live = await runLiveSummary(prisma);
  const [{ newest }] = await prisma.$queryRaw<{ newest: Date | null }[]>`
    SELECT max("timestamp") AS newest FROM turbine_latest`;
  const anomalies = newest
    ? await runAnomalyRollup(prisma, {
        now: new Date(Math.min(Date.now(), newest.getTime() + 5 * 60_000)),
      })
    : undefined;
  return (
    `${farmRollup} ${live.farms} live summaries,` +
    (anomalies && !anomalies.skipped
      ? ` anomaly rollup: ${anomalies.written} episodes,`
      : '')
  );
}

/**
 * Runs `seed` with a client on DATABASE_URL, after seeding the test users (SEED_USER_PASSWORD is
 * checked before anything is written: no password, no seed). Prints the returned summary; on an
 * error prints it and sets the exit code to 1.
 */
export async function runSeed(
  seed: (prisma: PrismaClient) => Promise<string>,
): Promise<void> {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    const users = await seedTestUsers(prisma);
    const summary = await seed(prisma);
    console.log(
      `${summary} ${users} users (${SEED_USERS.map((u) => u.email).join(', ')}; ` +
        'password from SEED_USER_PASSWORD).',
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}
