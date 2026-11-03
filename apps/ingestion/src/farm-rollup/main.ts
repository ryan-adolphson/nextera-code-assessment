// The farm rollup in the ingestion image (the Cloud Run Job's command, and the compose service):
//   node dist/farm-rollup/main.js [--from YYYY-MM-DD | --full] [--every <seconds>]
// Env only (DATABASE_URL), no .env. Host: `npm run rollup` / `npm run rollup:watch`
// (scripts/farm-rollup.ts). A one-off recompute on Cloud Run: `gcloud run jobs execute
// nextera-farm-rollup --args=dist/farm-rollup/main.js,--full` (--args replaces the job's args, so
// it must repeat the script path). See farm-rollup.ts.
import { runFarmRollupCli } from './farm-rollup.js';

process.exitCode = await runFarmRollupCli({
  argv: process.argv.slice(2),
  env: process.env,
});
