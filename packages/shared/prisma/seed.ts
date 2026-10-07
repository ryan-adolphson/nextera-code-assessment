import { config } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import argon2 from 'argon2';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { PASSWORD_HASH_OPTIONS } from '../src/auth/passwords.js';
import { seedFromCsv } from '../src/seed/seed-from-csv.js';
import { SEED_USERS, seedUsers } from '../src/seed/seed-users.js';

config({ path: ['.env', '../../.env'], quiet: true });

// Checked before anything is written: no password, no seed (there is never a default).
const password = process.env.SEED_USER_PASSWORD;

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

try {
  const users = await seedUsers(prisma, password, (pw) =>
    argon2.hash(pw, PASSWORD_HASH_OPTIONS),
  );
  const dataDir = join(dirname(fileURLToPath(import.meta.url)), 'data');
  const result = await seedFromCsv(prisma, dataDir);
  console.log(
    `Seeded ${result.farms} farms, ${result.turbines} turbines, ` +
      `${result.telemetryInserted} telemetry rows (${result.telemetrySkipped} already present), ` +
      `${users} users (${SEED_USERS.map((u) => u.email).join(', ')}; password from SEED_USER_PASSWORD).`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
