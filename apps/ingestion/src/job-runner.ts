import { setTimeout as delay } from 'node:timers/promises';
import { createPrismaClient, type PrismaClient } from '@nextera/shared';

/**
 * The shared runner of the maintenance jobs that ship in the ingestion image next to the worker
 * (partition-maintenance, live-summary, anomaly-rollup; the older farm-rollup and weather-sync
 * have their own): one run, or a loop with `--every <seconds>` (the compose services), on a small
 * pool of their own (outside the services' connection budget). A job module supplies a
 * `JobDefinition`; `main.ts` calls `runJobCli`.
 *
 * Exit code: one run exits 1 on bad arguments or environment or a failed run, 0 otherwise. In loop
 * mode a failed run is logged and the loop goes on (a database blip must not restart-loop the
 * container); it exits 0 on SIGTERM/SIGINT.
 */

export interface JobDefinition<Args extends { every?: number }, Resources> {
  /** For log lines and errors, e.g. "Live summary". */
  name: string;
  usage: string;
  /** Parses the CLI arguments (and checks the env); throws an Error with a message for the user. */
  parseArgs(
    argv: readonly string[],
    env: Record<string, string | undefined>,
    now: Date,
  ): Args;
  /** Opens what a run needs besides the database (a Redis connection); closed in `finally`. */
  open?(env: Record<string, string | undefined>, args: Args): Resources;
  close?(resources: Resources): Promise<void>;
  /** One run; resolves with the line to log. */
  run(
    db: PrismaClient,
    args: Args,
    resources: Resources,
    now: Date,
  ): Promise<string>;
}

export interface JobCliDeps {
  argv: readonly string[];
  env: Record<string, string | undefined>;
  createDb?: (url: string) => PrismaClient;
  now?: () => Date;
  /** Waits between loop runs; resolves early (or rejects) when `signal` aborts. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<unknown>;
  /** Aborted on SIGTERM/SIGINT in loop mode (default: a listener on the process). */
  signal?: AbortSignal;
  log?: Pick<Console, 'log' | 'error'>;
}

/** `--every <seconds>`: a whole number from 1 to 86400. */
export function parseEvery(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const every = Number(value);
  if (!/^\d+$/.test(value) || every < 1 || every > 86_400) {
    throw new Error(
      `--every must be a whole number of seconds from 1 to 86400, got "${value}"`,
    );
  }
  return every;
}

/** Runs the job once or in a loop; resolves with the process exit code. */
export async function runJobCli<Args extends { every?: number }, Resources>(
  job: JobDefinition<Args, Resources>,
  {
    argv,
    env,
    createDb = (url) => createPrismaClient(url, { max: 2 }),
    now = () => new Date(),
    sleep = (ms, signal) =>
      delay(ms, undefined, { signal }).catch(() => undefined),
    signal,
    log = console,
  }: JobCliDeps,
): Promise<number> {
  let args: Args;
  try {
    args = job.parseArgs(argv, env, now());
  } catch (error) {
    log.error(`${job.name}: ${(error as Error).message}\n${job.usage}`);
    return 1;
  }
  const url = env.DATABASE_URL;
  if (!url) {
    log.error(`${job.name}: DATABASE_URL is not set`);
    return 1;
  }

  let resources: Resources;
  try {
    resources = (job.open?.(env, args) ?? undefined) as Resources;
  } catch (error) {
    log.error(`${job.name}: ${(error as Error).message}`);
    return 1;
  }
  const db = createDb(url);
  const once = async (): Promise<boolean> => {
    const started = Date.now();
    try {
      const line = await job.run(db, args, resources, now());
      log.log(`${job.name}: ${line} (${Date.now() - started} ms)`);
      return true;
    } catch (error) {
      log.error(`${job.name}: failed: ${(error as Error).message}`);
      return false;
    }
  };

  try {
    if (args.every === undefined) return (await once()) ? 0 : 1;

    const stop = signal ?? stopOnSignals();
    log.log(`${job.name}: every ${args.every} s until stopped`);
    while (!stop.aborted) {
      await once(); // a failure is logged; the next run catches up
      if (stop.aborted) break;
      await sleep(args.every * 1000, stop);
    }
    log.log(`${job.name}: stopped`);
    return 0;
  } finally {
    await job.close?.(resources).catch(() => undefined);
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
