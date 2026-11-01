import { parseArgs } from 'node:util';
import {
  addDays,
  createPrismaClient,
  isUtcDay,
  syncFarmWeather,
  utcDay,
  type SyncWeatherOptions,
  type WeatherWriteClient,
} from '@nextera/shared';

/**
 * The farm weather sync (`npm run weather:sync`, or `node dist/weather-sync/main.js` in the
 * ingestion image: the Cloud Run Job nextera-weather-sync on a daily schedule). It fetches the
 * 15-minute Open-Meteo forecast-model weather for every farm (or --farm), aggregates it into
 * 30-minute buckets and upserts them into farm_weather (a re-fetch overwrites). It is not part of
 * the ingestion service: the worker never imports it.
 *
 * Args: --from YYYY-MM-DD --to YYYY-MM-DD (UTC days, inclusive; default the last 7 days up to
 * today, which also refreshes the recent days with the latest model run), --farm FARM01 (repeatable).
 * Env: DATABASE_URL (required), OPEN_METEO_API_KEY (optional: the paid customer-* hosts; the free
 * API is for non-commercial use only).
 * Exit code: 0 when every farm synced, 1 when any failed or the arguments/env are invalid.
 */

/** The default window: today and the 6 days before it (UTC). */
export const DEFAULT_SYNC_DAYS = 7;

export const WEATHER_SYNC_USAGE =
  'Usage: weather-sync [--from YYYY-MM-DD] [--to YYYY-MM-DD] [--farm FARM01]... ' +
  `(default: the last ${DEFAULT_SYNC_DAYS} UTC days up to today, every farm)`;

export interface WeatherSyncArgs {
  from: string;
  to: string;
  farmIds: string[];
}

/** Parses and checks the CLI arguments; throws an Error with a message for the user. */
export function parseWeatherSyncArgs(
  argv: readonly string[],
  now: Date,
): WeatherSyncArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      from: { type: 'string' },
      to: { type: 'string' },
      farm: { type: 'string', multiple: true },
    },
    strict: true,
    allowPositionals: false,
  });
  const today = utcDay(now);
  const day = (name: string, value: string) => {
    if (!isUtcDay(value)) {
      throw new Error(
        `${name} must be a day written as YYYY-MM-DD, got "${value}"`,
      );
    }
    return value;
  };
  const to = day('--to', values.to ?? today);
  const from = day(
    '--from',
    values.from ?? addDays(to, -(DEFAULT_SYNC_DAYS - 1)),
  );
  if (to < from) throw new Error('--to must not be before --from');
  if (to > today) throw new Error(`--to must not be after today (${today})`);
  const farmIds = [...new Set((values.farm ?? []).map((f) => f.trim()))];
  if (farmIds.some((f) => !f)) throw new Error('--farm must not be empty');
  return { from, to, farmIds };
}

export interface WeatherSyncDeps {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  /** Small pool: the job's connections are outside the services' connection budget. */
  createDb?: (
    url: string,
  ) => WeatherWriteClient & { $disconnect(): Promise<void> };
  now?: () => Date;
  fetch?: SyncWeatherOptions['fetch'];
  sleep?: SyncWeatherOptions['sleep'];
  log?: Pick<Console, 'log' | 'error'>;
}

/** Runs one sync; resolves with the process exit code. */
export async function runWeatherSync({
  argv,
  env,
  createDb = (url) => createPrismaClient(url, { max: 2 }),
  now = () => new Date(),
  fetch,
  sleep,
  log = console,
}: WeatherSyncDeps): Promise<number> {
  const at = now();
  let args: WeatherSyncArgs;
  try {
    args = parseWeatherSyncArgs(argv, at);
  } catch (error) {
    log.error(
      `Weather sync: ${(error as Error).message}\n${WEATHER_SYNC_USAGE}`,
    );
    return 1;
  }
  const url = env.DATABASE_URL;
  if (!url) {
    log.error('Weather sync: DATABASE_URL is not set');
    return 1;
  }
  const apiKey = env.OPEN_METEO_API_KEY || undefined;
  log.log(
    `Weather sync: ${args.from}..${args.to}, ${args.farmIds.length ? args.farmIds.join(', ') : 'every farm'}, ` +
      (apiKey
        ? 'Open-Meteo customer API (API key)'
        : 'Open-Meteo free API (non-commercial use only)'),
  );

  const db = createDb(url);
  try {
    const result = await syncFarmWeather(db, {
      from: args.from,
      to: args.to,
      farmIds: args.farmIds,
      now: at,
      apiKey,
      fetch,
      sleep,
      log: (line) => log.log(`Weather sync: ${line}`),
    });
    const written = result.farms.reduce((sum, f) => sum + f.written, 0);
    const summary = `Weather sync: ${result.farms.length - result.failed}/${result.farms.length} farms synced, ${written} rows written`;
    if (result.failed) {
      log.error(`${summary}, ${result.failed} failed`);
      return 1;
    }
    log.log(summary);
    return 0;
  } catch (error) {
    log.error(`Weather sync: failed: ${(error as Error).message}`);
    return 1;
  } finally {
    await db.$disconnect().catch(() => undefined);
  }
}
