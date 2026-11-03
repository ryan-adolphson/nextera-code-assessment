// npm run load:check: compares the rows stored for the load farm during the run with what the
// Artillery report says was sent, and reports the time to store (created_at - received_at).
// Writes load/results/check.json, exits 1 on a mismatch. Refuses any database that isn't local.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createPrismaClient } from '@nextera/shared';
import { localDatabaseUrl } from './local-db.js';
import { LOAD_FARM_ID } from './processor.js';

const results = (name) =>
  fileURLToPath(new URL(`results/${name}`, import.meta.url));
const REPORT = process.argv[2] ?? results('ingest.json');
const OUTPUT = process.argv[3] ?? results('check.json');
/** Around the report's window: received_at is the publish time, set just before each send. */
const MARGIN_MS = 15_000;

async function main() {
  const databaseUrl = localDatabaseUrl();
  const { counters, firstMetricAt, lastMetricAt } = JSON.parse(
    readFileSync(REPORT, 'utf8'),
  ).aggregate;
  const sent = counters['http.requests'] ?? 0;
  const acked = counters['http.codes.204'] ?? 0;
  const from = new Date(firstMetricAt - MARGIN_MS);
  const to = new Date(lastMetricAt + MARGIN_MS);

  const prisma = createPrismaClient(databaseUrl);
  try {
    const [rows] = await prisma.$queryRaw`
      WITH run AS (
        SELECT extract(epoch FROM created_at - received_at) * 1000 AS ms
        FROM telemetry
        WHERE farm_id = ${LOAD_FARM_ID} AND received_at >= ${from} AND received_at <= ${to}
      )
      SELECT count(*)::int AS stored,
             percentile_cont(0.5) WITHIN GROUP (ORDER BY ms)::float8 AS p50,
             percentile_cont(0.95) WITHIN GROUP (ORDER BY ms)::float8 AS p95,
             max(ms)::float8 AS max
      FROM run`;
    const unallocated = await prisma.unallocatedTurbine.count({
      where: { turbineId: { startsWith: 'LOAD' } },
    });
    const result = {
      sent,
      acked204: acked,
      stored: rows.stored,
      match: sent > 0 && sent === acked && sent === rows.stored,
      unallocatedEntries: unallocated,
      timeToStoreMs: { p50: rows.p50, p95: rows.p95, max: rows.max },
    };
    writeFileSync(OUTPUT, `${JSON.stringify(result, null, 2)}\n`);
    console.log(JSON.stringify(result, null, 2));
    if (!result.match) {
      console.error('Stored rows do not match what was sent.');
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
