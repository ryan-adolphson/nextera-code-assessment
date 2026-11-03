import { config } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import argon2 from 'argon2';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PASSWORD_HASH_OPTIONS } from '../src/auth/passwords.js';
import { SEED_USERS, seedUsers } from '../src/seed/seed-users.js';
import { runFarmRollup } from '../src/wind/farm-rollup.js';

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
 * One farm rollup run after a seed, so the farms' daily history (the web app's History tab, the
 * Playwright fixture) is there at once: incremental (the first run on a database is full). Skipped
 * if another run (the compose farm-rollup service) holds the lock: that one, or its next, covers it.
 */
export async function rollupAfterSeed(prisma: PrismaClient): Promise<string> {
  const started = Date.now();
  const r = await runFarmRollup(prisma);
  return r.skipped
    ? 'farm rollup skipped (another run holds the lock),'
    : `farm rollup: ${r.written} rows for ${r.farms} farms in ${Date.now() - started} ms,`;
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
