import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { ConfigService } from '@nestjs/config';
import {
  EventStore,
  FARM_ROLLUP_COMPLETED,
  FARM_ROLLUP_RETENTION_DAYS,
  createPrismaClient,
  isUtcDay,
  runFarmRollup,
  utcDay,
  type FarmRollupClient,
  type FarmRollupCompletedEvent,
  type FarmRollupMode,
  type FarmRollupOptions,
  type FarmRollupResult,
} from '@nextera/shared';

/**
 * The farm rollup runner (`npm run rollup`, or `node dist/farm-rollup/main.js` in the ingestion
 * image: the Cloud Run Job nextera-farm-rollup every 15 minutes, and the compose service
 * farm-rollup with --every 900). It recomputes the 30-minute farm series buckets that changed
 * (`runFarmRollup` in @nextera/shared). It is not part of the ingestion service: the worker never
 * imports it.
 *
 * Args: none = one incremental run; --full = every farm over the last 190 days; --from YYYY-MM-DD
 * = every farm from that UTC day; --every <seconds> = loop (incremental) until SIGTERM/SIGINT.
 * Env: DATABASE_URL (required); REDIS_URL (optional): after a committed, non-skipped run the job
 * publishes `farm-rollup.completed` (`{ asOf }` = the watermark) so open clients refetch the History
 * tab. Best effort: a Redis failure is logged and the run still succeeds; without REDIS_URL nothing
 * is published (logged once).
 * Exit code: a single run exits 1 on bad arguments/env or a failed run, 0 otherwise (also when
 * another run held the lock). In loop mode a failed run is logged and the loop goes on (a database
 * blip must not restart-loop the container); it exits 0 on a signal.
 */

export const FARM_ROLLUP_USAGE =
  'Usage: farm-rollup [--full | --from YYYY-MM-DD] | [--every <seconds>] ' +
  `(default: one incremental run; --full recomputes the last ${FARM_ROLLUP_RETENTION_DAYS} days)`;

export interface FarmRollupArgs {
  mode: FarmRollupMode;
  /** Loop interval in seconds; undefined = one run. */
  every?: number;
}

/** Parses and checks the CLI arguments; throws an Error with a message for the user. */
export function parseFarmRollupArgs(
  argv: readonly string[],
  now: Date,
): FarmRollupArgs {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      from: { type: 'string' },
      full: { type: 'boolean', default: false },
      every: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });
  if (values.full && values.from !== undefined) {
    throw new Error('--full and --from are mutually exclusive');
  }
  if (values.every !== undefined && (values.full || values.from)) {
    throw new Error('--every runs incrementally: drop --full / --from');
  }
  let every: number | undefined;
  if (values.every !== undefined) {
    every = Number(values.every);
    if (!/^\d+$/.test(values.every) || every < 1 || every > 86_400) {
      throw new Error(
        `--every must be a whole number of seconds from 1 to 86400, got "${values.every}"`,
      );
    }
  }
  if (values.from !== undefined) {
    if (!isUtcDay(values.from)) {
      throw new Error(
        `--from must be a day written as YYYY-MM-DD, got "${values.from}"`,
      );
    }
    const today = utcDay(now);
    if (values.from > today) {
      throw new Error(`--from must not be after today (${today})`);
    }
    return { mode: { kind: 'from', day: values.from } };
  }
  return { mode: { kind: values.full ? 'full' : 'incremental' }, every };
}

export const describeRun = (r: FarmRollupResult, ms: number): string =>
  r.skipped
    ? 'Farm rollup: skipped, another run holds the lock'
    : `Farm rollup: ${r.firstRun ? 'first run (full), ' : ''}${r.farms} farms from ${r.from ?? '-'}, ` +
      `${r.written} rows written (${r.deleted} replaced), ${r.pruned} pruned before ${r.cutoff}, ` +
      `${r.dirty} dirty markers, watermark ${r.watermark}, in ${ms} ms`;

export interface FarmRollupCliDeps {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  /** Small pool: the job's connections are outside the services' connection budget. */
  createDb?: (url: string) => FarmRollupClient & {
    $disconnect(): Promise<void>;
  };
  run?: (
    db: FarmRollupClient,
    options: FarmRollupOptions,
  ) => Promise<FarmRollupResult>;
  now?: () => Date;
  /** Builds the event publisher from REDIS_URL (only called when it is set). */
  createEvents?: (env: Record<string, string | undefined>) => EventStore;
  /** Waits between loop runs; resolves early (or rejects) when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<unknown>;
  /** Aborted on SIGTERM/SIGINT in loop mode (default: a listener on the process). */
  signal?: AbortSignal;
  log?: Pick<Console, 'log' | 'error'>;
}

/** Runs once or loops; resolves with the process exit code. */
export async function runFarmRollupCli({
  argv,
  env,
  createDb = (url) => createPrismaClient(url, { max: 2 }),
  run = runFarmRollup,
  now = () => new Date(),
  createEvents = (e) =>
    // EventStore only needs REDIS_URL from the config; a job has no Nest app.
    new EventStore({
      getOrThrow: (key: string) => e[key],
    } as unknown as ConfigService),
  sleep = (ms, signal) =>
    delay(ms, undefined, { signal }).catch(() => undefined),
  signal,
  log = console,
}: FarmRollupCliDeps): Promise<number> {
  let args: FarmRollupArgs;
  try {
    args = parseFarmRollupArgs(argv, now());
  } catch (error) {
    log.error(`Farm rollup: ${(error as Error).message}\n${FARM_ROLLUP_USAGE}`);
    return 1;
  }
  const url = env.DATABASE_URL;
  if (!url) {
    log.error('Farm rollup: DATABASE_URL is not set');
    return 1;
  }

  const db = createDb(url);
  // REDIS_URL is optional: the job image can roll out before Terraform sets it.
  let events: EventStore | undefined;
  if (env.REDIS_URL) {
    try {
      events = createEvents(env);
    } catch (error) {
      log.error(`Farm rollup: events disabled: ${(error as Error).message}`);
    }
  } else {
    log.log(
      'Farm rollup: REDIS_URL is not set, completion events are not published',
    );
  }

  const once = async (): Promise<boolean> => {
    const started = Date.now();
    let result: FarmRollupResult;
    try {
      result = await run(db, { mode: args.mode, now: now() });
    } catch (error) {
      log.error(`Farm rollup: failed: ${(error as Error).message}`);
      return false;
    }
    // The run has committed: publishing is best effort and never fails it.
    let published = '';
    if (events && !result.skipped && result.watermark) {
      try {
        const event: FarmRollupCompletedEvent = { asOf: result.watermark };
        await events.publish(FARM_ROLLUP_COMPLETED, event);
        published = ', event published';
      } catch (error) {
        published = `, event NOT published: ${(error as Error).message}`;
      }
    }
    log.log(describeRun(result, Date.now() - started) + published);
    return true;
  };

  try {
    if (args.every === undefined) return (await once()) ? 0 : 1;

    const stop = signal ?? stopOnSignals();
    log.log(`Farm rollup: every ${args.every} s until stopped`);
    while (!stop.aborted) {
      await once(); // a failure is logged; the next run catches up
      if (stop.aborted) break;
      await sleep(args.every * 1000, stop);
    }
    log.log('Farm rollup: stopped');
    return 0;
  } finally {
    await events?.onModuleDestroy().catch(() => undefined);
    await db.$disconnect().catch(() => undefined);
  }
}

/** An AbortSignal that aborts on SIGTERM (docker stop) or SIGINT (Ctrl+C). */
function stopOnSignals(): AbortSignal {
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGTERM', abort);
  process.once('SIGINT', abort);
  return controller.signal;
}
