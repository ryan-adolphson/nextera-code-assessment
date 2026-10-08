import { config } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import argon2 from 'argon2';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PASSWORD_HASH_OPTIONS } from '../src/auth/passwords.js';
import { SEED_USERS, seedUsers } from '../src/seed/seed-users.js';

/** Shared by `npm run db:seed` (seed.ts) and `npm run db:seed:demo` (seed-demo.ts). */

// One .env at the repo root; real environment variables win.
config({ path: ['.env', '../../.env'], quiet: true });

/** The fixture CSVs (prisma/data). */
export const DATA_DIR = join(dirname(fileURLToPath(import.meta.url)), 'data');

/**
 * Runs `seed` with a client on DATABASE_URL, after seeding the test users (SEED_USER_PASSWORD is
 * checked before anything is written: no password, no seed). Prints the returned summary; on an
 * error prints it and sets the exit code to 1.
 */
export async function runSeed(
  seed: (prisma: PrismaClient) => Promise<string>,
): Promise<void> {
  const password = process.env.SEED_USER_PASSWORD;
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
  });
  try {
    const users = await seedUsers(prisma, password, (pw) =>
      argon2.hash(pw, PASSWORD_HASH_OPTIONS),
    );
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
