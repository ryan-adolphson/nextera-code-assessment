// npm run load:setup: creates the load fleet (farm LOAD01, LOAD_FLEET_SIZE turbines), so readings
// are stored and don't land in Unallocated. Idempotent. Refuses any database that isn't local.
import { createPrismaClient } from '@nextera/shared';
import { localDatabaseUrl } from './local-db.js';
import { LOAD_FARM_ID, fleetSize, loadTurbineId } from './processor.js';

const BATCH_SIZE = 1000;

async function main() {
  const size = fleetSize();
  const prisma = createPrismaClient(localDatabaseUrl());
  try {
    await prisma.farm.upsert({
      where: { id: LOAD_FARM_ID },
      update: {},
      create: {
        id: LOAD_FARM_ID,
        name: 'Load test',
        latitude: 41,
        longitude: -96,
      },
    });
    let created = 0;
    for (let start = 0; start < size; start += BATCH_SIZE) {
      const { count } = await prisma.turbine.createMany({
        data: Array.from(
          { length: Math.min(BATCH_SIZE, size - start) },
          (_, offset) => ({
            turbineId: loadTurbineId(start + offset),
            farmId: LOAD_FARM_ID,
            latitude: 41,
            longitude: -96,
            commissioned: true,
          }),
        ),
        skipDuplicates: true,
      });
      created += count;
    }
    console.log(
      `Load fleet: ${size} turbines on farm ${LOAD_FARM_ID} (${created} new).`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
