import { seedFromCsv } from '../src/seed/seed-from-csv.js';
import { DATA_DIR, runSeed } from './seed-support.js';

// npm run db:seed: the fixture CSVs (prisma/data) + the test users.
await runSeed(async (prisma) => {
  const result = await seedFromCsv(prisma, DATA_DIR);
  return (
    `Seeded ${result.farms} farms, ${result.turbines} turbines, ` +
    `${result.telemetryInserted} telemetry rows (${result.telemetrySkipped} already present),`
  );
});
