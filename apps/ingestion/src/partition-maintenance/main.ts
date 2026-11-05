// Partition maintenance in the ingestion image (the Cloud Run Job's command, and the compose service):
//   node dist/partition-maintenance/main.js [--days-ahead <n>] [--every <seconds>]
// Env only (DATABASE_URL, TELEMETRY_RETENTION_DAYS), no .env. Host: `npm run partitions:maintain`
// (scripts/partition-maintenance.ts). See partition-maintenance.ts.
import { runJobCli } from '../job-runner.js';
import { partitionMaintenanceJob } from './partition-maintenance.js';

process.exitCode = await runJobCli(partitionMaintenanceJob, {
  argv: process.argv.slice(2),
  env: process.env,
});
