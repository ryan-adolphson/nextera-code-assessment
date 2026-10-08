// The demo feed in the ingestion image: `node dist/demo-feed/main.js [--once]` (env only, no .env).
// Host: `npm run demo:feed` (scripts/demo-feed.ts). See demo-feed.ts.
import { startDemoFeed } from './demo-feed.js';

await startDemoFeed();
