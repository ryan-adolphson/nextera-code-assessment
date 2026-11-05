// The live summary in the ingestion image (the Cloud Run Job's command, and the compose service):
//   node dist/live-summary/main.js [--every <seconds>] [--no-publish]
// Env only (DATABASE_URL, REDIS_URL), no .env. Host: `npm run live:summary` (scripts/live-summary.ts).
import { runJobCli } from '../job-runner.js';
import { liveSummaryJob } from './live-summary.js';

process.exitCode = await runJobCli(liveSummaryJob, {
  argv: process.argv.slice(2),
  env: process.env,
});
