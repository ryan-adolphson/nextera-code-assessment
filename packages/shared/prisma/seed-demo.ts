import { parseDemoSeedEnv, seedDemo } from '../src/seed/seed-demo.js';
import { DATA_DIR, runSeed } from './seed-support.js';

// npm run db:seed:demo: the fixture farms, 25 demo turbines, default alert rules and generated
// telemetry for the last SEED_HOURS (72) up to SEED_NOW (now), with telemetry_alerts, + the test
// users. Idempotent: a re-run tops up to now.
await runSeed(async (prisma) => {
  const { end, hours } = parseDemoSeedEnv(process.env);
  const r = await seedDemo(prisma, { dataDir: DATA_DIR, end, hours });
  return (
    `Demo seed: ${r.farms} farms, ${r.turbines} turbines, ` +
    `${r.rulesCreated} default alert rules created (${r.rulesEvaluated} enabled rules evaluated), ` +
    `${r.inserted} telemetry rows inserted (${r.skipped} already present) from ${r.from} to ${r.to}, ` +
    `${r.alerts} triggered alerts stored,`
  );
});
