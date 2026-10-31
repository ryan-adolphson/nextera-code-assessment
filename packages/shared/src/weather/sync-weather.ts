import { setTimeout as delay } from 'node:timers/promises';
import { Prisma } from '../generated/prisma/client.js';
import {
  WEATHER_VARIABLES,
  fetchFarmWeather,
  planRequests,
  type WeatherHourRow,
} from './open-meteo.js';

/** Rows per INSERT (each column travels as one array parameter, so this only bounds memory). */
export const WEATHER_UPSERT_BATCH = 2_000;
/** Pause between two Open-Meteo requests (requests are sequential). */
export const WEATHER_REQUEST_DELAY_MS = 250;

/** What the sync needs from Prisma (a PrismaClient or a transaction fits). */
export type WeatherWriteClient = Prisma.TransactionClient;

const COLUMNS = WEATHER_VARIABLES.map((v) => v.column);
const INSERT_COLUMNS = Prisma.raw(COLUMNS.join(', '));
const UNNEST_ALIASES = Prisma.raw(['time', 'source', ...COLUMNS].join(', '));
const SELECT_VALUES = Prisma.raw(COLUMNS.map((c) => `h.${c}`).join(', '));
const UPDATE_SET = Prisma.raw(
  [...COLUMNS, 'source', 'fetched_at']
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(', '),
);

/**
 * Upserts a farm's hourly weather; returns the number of rows inserted or updated. An archive row
 * is never overwritten by a forecast row; a forecast row is replaced by anything newer (archive or
 * a fresher forecast); an archive row by a re-fetched archive row. Idempotent.
 */
export async function upsertWeatherHours(
  db: WeatherWriteClient,
  farmId: string,
  rows: readonly WeatherHourRow[],
): Promise<number> {
  // One row per hour (a statement may not update the same row twice); the last one wins.
  const unique = [...new Map(rows.map((r) => [r.time.getTime(), r])).values()];
  let written = 0;
  for (let i = 0; i < unique.length; i += WEATHER_UPSERT_BATCH) {
    const batch = unique.slice(i, i + WEATHER_UPSERT_BATCH);
    const arrays = WEATHER_VARIABLES.map(
      ({ field }) => Prisma.sql`${batch.map((r) => r[field])}::float8[]`,
    );
    written += await db.$executeRaw`
      INSERT INTO farm_weather_hourly (farm_id, time, source, ${INSERT_COLUMNS}, fetched_at)
      SELECT ${farmId}, h.time, h.source::weather_source, ${SELECT_VALUES}, now()
      FROM unnest(
        ${batch.map((r) => r.time.toISOString())}::timestamptz[],
        ${batch.map((r) => r.source)}::text[],
        ${Prisma.join(arrays)}
      ) AS h(${UNNEST_ALIASES})
      ON CONFLICT (farm_id, time) DO UPDATE SET ${UPDATE_SET}
      WHERE farm_weather_hourly.source = 'forecast' OR EXCLUDED.source = 'archive'`;
  }
  return written;
}

export interface SyncWeatherOptions {
  /** First UTC day (YYYY-MM-DD). */
  from: string;
  /** Last UTC day (YYYY-MM-DD, inclusive, not after today). */
  to: string;
  /** Only these farms (default: every farm). An unknown id is reported as a failure. */
  farmIds?: readonly string[];
  now?: Date;
  apiKey?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  delayMs?: number;
  log?: (line: string) => void;
}

export interface FarmWeatherSyncResult {
  farmId: string;
  ok: boolean;
  /** Hours received per source. */
  archiveHours: number;
  forecastHours: number;
  /** Rows inserted or updated (an archive row a forecast didn't overwrite isn't counted). */
  written: number;
  error?: string;
}

export interface SyncWeatherResult {
  from: string;
  to: string;
  farms: FarmWeatherSyncResult[];
  /** Farms that failed; the runner exits non-zero when this isn't 0. */
  failed: number;
}

/**
 * Fetches and stores the hourly weather of every farm (or `farmIds`) for the UTC days from..to.
 * One farm failing doesn't stop the others: its error is in the result (and logged), and whatever
 * it stored before the failure stays (the upsert is idempotent, so a re-run completes it).
 * Throws only for an invalid range (before any request).
 */
export async function syncFarmWeather(
  db: WeatherWriteClient,
  {
    from,
    to,
    farmIds,
    now = new Date(),
    apiKey,
    fetch: fetchFn,
    sleep = (ms: number) => delay(ms),
    delayMs = WEATHER_REQUEST_DELAY_MS,
    log = () => undefined,
  }: SyncWeatherOptions,
): Promise<SyncWeatherResult> {
  const requests = planRequests(from, to, now);
  const farms = await db.farm.findMany({
    ...(farmIds?.length && { where: { id: { in: [...farmIds] } } }),
    orderBy: { id: 'asc' },
    select: { id: true, latitude: true, longitude: true },
  });

  const results: FarmWeatherSyncResult[] = [];
  for (const missing of (farmIds ?? []).filter(
    (id) => !farms.some((farm) => farm.id === id),
  )) {
    const error = `Farm ${missing} not found`;
    log(`${missing}: failed: ${error}`);
    results.push({
      farmId: missing,
      ok: false,
      archiveHours: 0,
      forecastHours: 0,
      written: 0,
      error,
    });
  }

  let requestCount = 0;
  for (const farm of farms) {
    const result: FarmWeatherSyncResult = {
      farmId: farm.id,
      ok: true,
      archiveHours: 0,
      forecastHours: 0,
      written: 0,
    };
    try {
      for (const request of requests) {
        if (requestCount++ > 0) await sleep(delayMs);
        const rows = await fetchFarmWeather({
          ...request,
          latitude: farm.latitude.toNumber(),
          longitude: farm.longitude.toNumber(),
          apiKey,
          fetch: fetchFn,
          sleep,
        });
        result[`${request.source}Hours`] += rows.length;
        result.written += await upsertWeatherHours(db, farm.id, rows);
      }
      log(
        `${farm.id}: ok: ${result.archiveHours} archive + ${result.forecastHours} forecast hours, ${result.written} rows written`,
      );
    } catch (error) {
      result.ok = false;
      result.error = (error as Error).message;
      log(`${farm.id}: failed: ${result.error}`);
    }
    results.push(result);
  }

  results.sort((a, b) => a.farmId.localeCompare(b.farmId));
  return {
    from,
    to,
    farms: results,
    failed: results.filter((r) => !r.ok).length,
  };
}
