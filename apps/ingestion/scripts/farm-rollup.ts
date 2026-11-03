/**
 * The farm rollup on the host: 30-minute farm series buckets into farm_telemetry_rollups.
 *   npm run rollup                          # one incremental run
 *   npm run rollup -- --full                # recompute the last 190 days
 *   npm run rollup -- --from 2026-10-01     # recompute every farm from that UTC day
 *   npm run rollup:watch                    # every 60 s until Ctrl+C (--every 60)
 * Reads DATABASE_URL from the repo-root .env (real env vars win).
 * The ingestion image runs the same code as `node dist/farm-rollup/main.js` (see src/farm-rollup).
 */
import { config } from 'dotenv';
import { runFarmRollupCli } from '../src/farm-rollup/farm-rollup.js';

config({ path: ['.env', '../../.env'], quiet: true });

process.exitCode = await runFarmRollupCli({
  argv: process.argv.slice(2),
  env: process.env,
});
