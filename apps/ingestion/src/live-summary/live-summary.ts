import { parseArgs } from 'node:util';
import { ConfigService } from '@nestjs/config';
import {
  EventStore,
  FLEET_TICK,
  runLiveSummary,
  type FleetTickEvent,
} from '@nextera/shared';
import { parseEvery, type JobDefinition } from '../job-runner.js';

/**
 * The live summary (`node dist/live-summary/main.js`, `npm run live:summary`): rebuilds
 * farm_live_summary from turbine_latest, then publishes `fleet.tick` (`{ asOf }`, on the Redis
 * stream: it is low volume) so connected clients refetch the fleet tiles. Every minute (Cloud Run
 * Job + Scheduler; compose `--every 60`). Not part of the ingestion service.
 *
 * Args: `--every <seconds>`, `--no-publish` (only rebuild). Env: DATABASE_URL, REDIS_URL (unless
 * --no-publish). The tick is best-effort: the summaries are committed first, and a Redis failure
 * is only logged.
 */

export const LIVE_SUMMARY_USAGE =
  'Usage: live-summary [--every <seconds>] [--no-publish]  (env: DATABASE_URL, REDIS_URL)';

export interface LiveSummaryArgs {
  publish: boolean;
  every?: number;
}

export const liveSummaryJob: JobDefinition<
  LiveSummaryArgs,
  EventStore | undefined
> = {
  name: 'Live summary',
  usage: LIVE_SUMMARY_USAGE,
  parseArgs(argv, env) {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        every: { type: 'string' },
        'no-publish': { type: 'boolean', default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    const publish = !values['no-publish'];
    if (publish && !env.REDIS_URL) {
      throw new Error('REDIS_URL is not set (or pass --no-publish)');
    }
    return { publish, every: parseEvery(values.every) };
  },
  open(env, { publish }) {
    if (!publish) return undefined;
    // EventStore only needs REDIS_URL from the config; a job has no Nest app.
    return new EventStore({
      getOrThrow: (key: string) => env[key],
    } as unknown as ConfigService);
  },
  async close(events) {
    await events?.onModuleDestroy();
  },
  async run(db, _args, events, now) {
    const { farms, asOf } = await runLiveSummary(db, { now });
    if (!events) return `${farms} farm summaries as of ${asOf}`;
    try {
      const tick: FleetTickEvent = { asOf };
      await events.publish(FLEET_TICK, tick);
      return `${farms} farm summaries as of ${asOf}, tick published`;
    } catch (error) {
      return `${farms} farm summaries as of ${asOf}, tick NOT published: ${(error as Error).message}`;
    }
  },
};
