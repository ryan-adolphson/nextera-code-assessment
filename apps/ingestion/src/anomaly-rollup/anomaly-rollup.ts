import { parseArgs } from 'node:util';
import {
  isUtcDay,
  runAnomalyRollup,
  utcDay,
  type AnomalyRollupMode,
  type AnomalyRollupResult,
} from '@nextera/shared';
import { parseEvery, type JobDefinition } from '../job-runner.js';

/**
 * The anomaly rollup (`node dist/anomaly-rollup/main.js`, `npm run anomalies:rollup`): stores the
 * anomaly episodes (`anomaly_episodes`) with the same rules `listAnomalies` applies on read,
 * hourly and incrementally. Cloud Run Job + Scheduler hourly; compose `--every 3600`. Not part of
 * the ingestion service. See `runAnomalyRollup` (@nextera/shared) for the window and its limits.
 *
 * Args: none = one incremental run (the first on a database looks back 7 days);
 * `--from YYYY-MM-DD` = recompute every turbine from that UTC day; `--every <seconds>` = loop.
 * Env: DATABASE_URL.
 */

export const ANOMALY_ROLLUP_USAGE =
  'Usage: anomaly-rollup [--from YYYY-MM-DD] | [--every <seconds>]  (default: one incremental run)';

export interface AnomalyRollupArgs {
  mode: AnomalyRollupMode;
  every?: number;
}

export function describeRollup(r: AnomalyRollupResult): string {
  return r.skipped
    ? 'skipped, another run holds the lock'
    : `${r.written} episodes written (${r.deleted} replaced, ${r.reopened} open ones restarted, ` +
        `${r.pruned} pruned) from ${r.from} to ${r.asOf} in ${r.chunks} chunk(s); ` +
        `${r.bins} wind bins${r.sampleDivisor > 1 ? ` from 1 in ${r.sampleDivisor} turbines` : ''}`;
}

export const anomalyRollupJob: JobDefinition<AnomalyRollupArgs, undefined> = {
  name: 'Anomaly rollup',
  usage: ANOMALY_ROLLUP_USAGE,
  parseArgs(argv, _env, now) {
    const { values } = parseArgs({
      args: [...argv],
      options: { from: { type: 'string' }, every: { type: 'string' } },
      strict: true,
      allowPositionals: false,
    });
    if (values.every !== undefined && values.from !== undefined) {
      throw new Error('--every runs incrementally: drop --from');
    }
    if (values.from !== undefined) {
      if (!isUtcDay(values.from)) {
        throw new Error(
          `--from must be a day written as YYYY-MM-DD, got "${values.from}"`,
        );
      }
      if (values.from > utcDay(now)) {
        throw new Error(`--from must not be after today (${utcDay(now)})`);
      }
      return { mode: { kind: 'from', day: values.from } };
    }
    return { mode: { kind: 'incremental' }, every: parseEvery(values.every) };
  },
  async run(db, { mode }, _resources, now) {
    return describeRollup(await runAnomalyRollup(db, { mode, now }));
  },
};
