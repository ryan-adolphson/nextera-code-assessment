import { config } from 'dotenv';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { seedFromCsv } from '../src/seed/seed-from-csv.js';

config({ path: ['.env', '../../.env'], quiet: true });

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
});

try {
  const dataDir = join(dirname(fileURLToPath(import.meta.url)), 'data');
  const result = await seedFromCsv(prisma, dataDir);
  console.log(
    `Seeded ${result.farms} farms, ${result.turbines} turbines, ` +
      `${result.telemetryInserted} telemetry rows (${result.telemetrySkipped} already present).`,
  );
} finally {
  await prisma.$disconnect();
}
