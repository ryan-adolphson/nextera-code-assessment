// The farm weather sync in the ingestion image (the Cloud Run Job's command):
//   node dist/weather-sync/main.js [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--farm FARM01]...
// Env only (DATABASE_URL, OPEN_METEO_API_KEY), no .env. Host: `npm run weather:sync`
// (scripts/weather-sync.ts). A one-off backfill on Cloud Run: `gcloud run jobs execute
// nextera-weather-sync --args=dist/weather-sync/main.js,--from,2026-01-01,--to,2026-01-31`
// (--args replaces the job's args, so it must repeat the script path). See weather-sync.ts.
import { runWeatherSync } from './weather-sync.js';

process.exitCode = await runWeatherSync({
  argv: process.argv.slice(2),
  env: process.env,
});
