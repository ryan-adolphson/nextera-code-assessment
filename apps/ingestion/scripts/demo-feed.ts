/**
 * The live demo feed on the host: publishes one reading per demo turbine every
 * DEMO_FEED_INTERVAL_SECONDS (300) to the telemetry topic, continuing `npm run db:seed:demo`.
 *   DEMO_FEED_ENABLED=true npm run demo:feed              # loop (Ctrl+C stops it)
 *   DEMO_FEED_ENABLED=true npm run demo:feed -- --once    # one tick
 *   GCP: PUBSUB_EMULATOR_HOST= GOOGLE_CLOUD_PROJECT=<project> DEMO_FEED_ENABLED=true npm run demo:feed
 * The ingestion image runs the same code as `node dist/demo-feed/main.js` (see src/demo-feed).
 */
import { config } from 'dotenv';
import { startDemoFeed } from '../src/demo-feed/demo-feed.js';

config({ path: ['.env', '../../.env'], quiet: true });

await startDemoFeed();
