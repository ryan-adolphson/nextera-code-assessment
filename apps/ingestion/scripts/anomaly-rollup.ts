/**
 * The anomaly rollup on the host: anomaly_episodes from the stored readings.
 *   npm run anomalies:rollup
 * Reads DATABASE_URL from the repo-root .env (real env vars win). --from YYYY-MM-DD recomputes from a day; --every 3600 loops.
 * The ingestion image runs the same code as `node dist/anomaly-rollup/main.js` (see src/anomaly-rollup).
 */
import { config } from 'dotenv';
import { runJobCli } from '../src/job-runner.js';
import { anomalyRollupJob } from '../src/anomaly-rollup/anomaly-rollup.js';

config({ path: ['.env', '../../.env'], quiet: true });

process.exitCode = await runJobCli(anomalyRollupJob, {
  argv: process.argv.slice(2),
  env: process.env,
});
