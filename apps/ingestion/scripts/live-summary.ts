/**
 * The live summary on the host: rebuilds farm_live_summary from turbine_latest and publishes fleet.tick.
 *   npm run live:summary
 * Reads DATABASE_URL and REDIS_URL from the repo-root .env (real env vars win). --every 60 loops; --no-publish skips the tick.
 * The ingestion image runs the same code as `node dist/live-summary/main.js` (see src/live-summary).
 */
import { config } from 'dotenv';
import { runJobCli } from '../src/job-runner.js';
import { liveSummaryJob } from '../src/live-summary/live-summary.js';

config({ path: ['.env', '../../.env'], quiet: true });

process.exitCode = await runJobCli(liveSummaryJob, {
  argv: process.argv.slice(2),
  env: process.env,
});
