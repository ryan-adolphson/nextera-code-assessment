/**
 * The farm weather sync on the host: 30-minute Open-Meteo weather per farm into farm_weather.
 *   npm run weather:sync                                          # the last 7 UTC days, every farm
 *   npm run weather:sync -- --from 2026-01-01 --to 2026-01-31     # a backfill
 *   npm run weather:sync -- --farm FARM01 --farm FARM02           # some farms only
 * Reads DATABASE_URL and OPEN_METEO_API_KEY from the repo-root .env (real env vars win).
 * The ingestion image runs the same code as `node dist/weather-sync/main.js` (see src/weather-sync).
 */
import { config } from 'dotenv';
import { runWeatherSync } from '../src/weather-sync/weather-sync.js';

config({ path: ['.env', '../../.env'], quiet: true });

process.exitCode = await runWeatherSync({
  argv: process.argv.slice(2),
  env: process.env,
});
