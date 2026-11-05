// The anomaly rollup in the ingestion image (the Cloud Run Job's command, and the compose service):
//   node dist/anomaly-rollup/main.js [--from YYYY-MM-DD] [--every <seconds>]
// Env only (DATABASE_URL), no .env. Host: `npm run anomalies:rollup` (scripts/anomaly-rollup.ts).
import { runJobCli } from '../job-runner.js';
import { anomalyRollupJob } from './anomaly-rollup.js';

process.exitCode = await runJobCli(anomalyRollupJob, {
  argv: process.argv.slice(2),
  env: process.env,
});
