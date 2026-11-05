/**
 * The partition maintenance on the host: daily telemetry partitions ahead; with TELEMETRY_RETENTION_DAYS set, drops older days.
 *   npm run partitions:maintain
 * Reads DATABASE_URL and TELEMETRY_RETENTION_DAYS from the repo-root .env (real env vars win).
 * The ingestion image runs the same code as `node dist/partition-maintenance/main.js` (see src/partition-maintenance).
 */
import { config } from 'dotenv';
import { runJobCli } from '../src/job-runner.js';
import { partitionMaintenanceJob } from '../src/partition-maintenance/partition-maintenance.js';

config({ path: ['.env', '../../.env'], quiet: true });

process.exitCode = await runJobCli(partitionMaintenanceJob, {
  argv: process.argv.slice(2),
  env: process.env,
});
