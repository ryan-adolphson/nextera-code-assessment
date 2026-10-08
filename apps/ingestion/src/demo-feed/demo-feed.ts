import { setTimeout as sleep } from 'node:timers/promises';
import { PubSub } from '@google-cloud/pubsub';
import {
  DEMO_SEED,
  DEMO_TURBINES,
  TELEMETRY_STEP_MINUTES,
  floorToTelemetryStep,
  generateTelemetry,
  type GeneratedTelemetryRow,
} from '@nextera/shared';

/**
 * The live demo feed (`npm run demo:feed`, or `node dist/demo-feed/main.js` in the ingestion
 * image): every tick publishes one reading per demo turbine to the telemetry topic, timestamped at
 * the current 5-minute boundary and continuing the demo seed's curve (same generator and seed).
 * The readings go through Pub/Sub → ingestion like a real turbine's, so alerts and SSE work as in
 * production. It is not part of the ingestion service: the worker never imports it.
 *
 * Env: DEMO_FEED_ENABLED (must be "true", else it exits 0), DEMO_FEED_INTERVAL_SECONDS (300),
 * DEMO_FEED_ONCE=true or --once (one tick, then exit: a Cloud Run Job), PUBSUB_TOPIC (telemetry),
 * GOOGLE_CLOUD_PROJECT, PUBSUB_EMULATOR_HOST.
 */

export const DEMO_FEED_DISABLED_MESSAGE =
  'Demo feed disabled (DEMO_FEED_ENABLED != true)';

/** The part of the Pub/Sub client the feed uses (a PubSub instance fits). */
export interface DemoFeedPubSub {
  topic(name: string): {
    publishMessage(message: { json: unknown }): Promise<string>;
  };
  close(): Promise<void>;
}

export interface DemoFeedDeps {
  env: Record<string, string | undefined>;
  argv: readonly string[];
  createPubSub: (projectId: string | undefined) => DemoFeedPubSub;
  /** Aborted on SIGTERM/SIGINT: the current tick finishes, then the feed stops. */
  signal?: AbortSignal;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  log?: Pick<Console, 'log' | 'error'>;
}

/** The readings of one tick: one per demo turbine at `at` (floored), minus a stopped turbine. */
export function demoFeedReadings(
  at: Date | number,
): Omit<GeneratedTelemetryRow, 'received_at'>[] {
  return generateTelemetry({
    turbines: DEMO_TURBINES,
    end: floorToTelemetryStep(at),
    hours: TELEMETRY_STEP_MINUTES / 60, // one step
    seed: DEMO_SEED,
  }).map(({ received_at: _receivedAt, ...reading }) => reading); // live: Pub/Sub publishTime
}

/** Runs the feed; resolves with the process exit code. */
export async function runDemoFeed({
  env,
  argv,
  createPubSub,
  signal,
  now = Date.now,
  sleep: wait = defaultSleep,
  log = console,
}: DemoFeedDeps): Promise<number> {
  if (env.DEMO_FEED_ENABLED !== 'true') {
    log.log(DEMO_FEED_DISABLED_MESSAGE);
    return 0;
  }
  const once = argv.includes('--once') || env.DEMO_FEED_ONCE === 'true';
  const intervalSeconds = Number(env.DEMO_FEED_INTERVAL_SECONDS ?? 300);
  if (!Number.isInteger(intervalSeconds) || intervalSeconds < 1) {
    log.error(
      `DEMO_FEED_INTERVAL_SECONDS must be a whole number of seconds ≥ 1, got "${env.DEMO_FEED_INTERVAL_SECONDS}"`,
    );
    return 1;
  }
  const topicName = env.PUBSUB_TOPIC || 'telemetry';
  // Unset on Cloud Run: the client finds the project itself. The emulator accepts any project.
  const projectId =
    env.GOOGLE_CLOUD_PROJECT ||
    (env.PUBSUB_EMULATOR_HOST ? 'nextera-local' : undefined);

  const pubsub = createPubSub(projectId);
  const topic = pubsub.topic(topicName);
  const tick = async () => {
    const readings = demoFeedReadings(now());
    await Promise.all(
      readings.map((reading) => topic.publishMessage({ json: reading })),
    );
    log.log(
      `Demo feed: published ${readings.length} readings for ${readings[0]?.timestamp} to ${topicName}`,
    );
  };

  log.log(
    once
      ? `Demo feed: one tick to ${topicName}`
      : `Demo feed: every ${intervalSeconds}s to ${topicName}`,
  );
  try {
    while (!signal?.aborted) {
      try {
        await tick();
      } catch (error) {
        log.error(`Demo feed: publish failed: ${(error as Error).message}`);
        // A job run fails (Cloud Run retries it); a loop tries again next tick.
        if (once) return 1;
      }
      if (once) break;
      await wait(intervalSeconds * 1000, signal);
    }
    if (signal?.aborted) log.log('Demo feed: stopped');
    return 0;
  } finally {
    await pubsub.close();
  }
}

/** Entry point: the real client and env, stopping cleanly on SIGTERM/SIGINT. */
export async function startDemoFeed(): Promise<void> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  process.exitCode = await runDemoFeed({
    env: process.env,
    argv: process.argv.slice(2),
    createPubSub: (projectId) => new PubSub({ projectId }),
    signal: controller.signal,
  });
  process.off('SIGTERM', stop);
  process.off('SIGINT', stop);
}

/** Resolves after `ms`, or as soon as `signal` aborts. */
async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  await sleep(ms, undefined, { signal }).catch(() => undefined);
}
