import {
  assertLocalDatabase,
  parseScaleSeedEnv,
  seedScale,
} from '../src/seed/seed-scale.js';
import { runSeed } from './seed-support.js';

// npm run db:seed:scale: a million turbines for load tests (local database only, set-based SQL):
// SCALE_FARMS (10000), SCALE_TURBINES (1000000), SCALE_SAMPLE_PERCENT (1), SCALE_HOURS (24),
// SCALE_NOW (now). Then `npm run rollup` and `npm run anomalies:rollup` if you want those tables.
// Idempotent: a re-run tops up to now.
assertLocalDatabase(process.env.DATABASE_URL);
await runSeed(async (prisma) => {
  const options = parseScaleSeedEnv(process.env);
  const started = Date.now();
  const r = await seedScale(prisma, options, (line) => console.log(line));
  return (
    `Scale seed: ${r.farms} farms, ${r.turbines} turbines, ${r.telemetryRows} readings for ` +
    `${r.sampleTurbines} sample turbines (${r.alerts} alerts) from ${r.from} to ${r.to}, ` +
    `in ${Math.round((Date.now() - started) / 1000)} s,`
  );
});
