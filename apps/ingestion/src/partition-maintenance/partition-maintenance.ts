import { parseArgs } from 'node:util';
import {
  PARTITION_DAYS_AHEAD,
  runPartitionMaintenance,
  type PartitionMaintenanceResult,
} from '@nextera/shared';
import { parseEvery, type JobDefinition } from '../job-runner.js';

/**
 * Partition maintenance (`node dist/partition-maintenance/main.js`, `npm run partitions:maintain`):
 * creates the daily telemetry partitions ahead (and carves recent rows out of the DEFAULT
 * partition), and, only when TELEMETRY_RETENTION_DAYS is set, drops the daily partitions past the
 * retention with their alerts and purges the DEFAULT partition's older rows. Unset means keep
 * everything, so a local database keeps its fixtures. Daily is enough (`--every 86400` in compose);
 * it is not part of the ingestion service. See `runPartitionMaintenance` (@nextera/shared).
 *
 * Args: `--days-ahead <n>` (default 3), `--every <seconds>`. Env: DATABASE_URL (required),
 * TELEMETRY_RETENTION_DAYS (optional, a whole number ≥ 1).
 */

export const PARTITION_MAINTENANCE_USAGE =
  'Usage: partition-maintenance [--days-ahead <n>] [--every <seconds>]  ' +
  '(env: TELEMETRY_RETENTION_DAYS — unset keeps all readings)';

export interface PartitionMaintenanceArgs {
  retentionDays: number | null;
  daysAhead: number;
  every?: number;
}

/** The retention from the environment: unset or empty = none. */
export function parseRetentionDays(value: string | undefined): number | null {
  if (value === undefined || value.trim() === '') return null;
  if (!/^\d+$/.test(value.trim()) || Number(value) < 1) {
    throw new Error(
      `TELEMETRY_RETENTION_DAYS must be a whole number of days from 1, got "${value}"`,
    );
  }
  return Number(value);
}

export function describeMaintenance(r: PartitionMaintenanceResult): string {
  if (r.skipped) {
    return 'skipped: another partition maintenance run is in progress';
  }
  const days = r.created.length ? ` (${r.created.join(', ')})` : '';
  const retention = r.retentionCutoff
    ? `retention cutoff ${r.retentionCutoff}: dropped ${r.dropped} day partition(s), purged ${r.purgedDefault} default row(s)`
    : 'no retention set: nothing dropped';
  return `created ${r.created.length} day partition(s)${days}, ${retention}`;
}

export const partitionMaintenanceJob: JobDefinition<
  PartitionMaintenanceArgs,
  undefined
> = {
  name: 'Partition maintenance',
  usage: PARTITION_MAINTENANCE_USAGE,
  parseArgs(argv, env) {
    const { values } = parseArgs({
      args: [...argv],
      options: {
        'days-ahead': { type: 'string' },
        every: { type: 'string' },
      },
      strict: true,
      allowPositionals: false,
    });
    let daysAhead = PARTITION_DAYS_AHEAD;
    if (values['days-ahead'] !== undefined) {
      daysAhead = Number(values['days-ahead']);
      if (!/^\d+$/.test(values['days-ahead']) || daysAhead > 31) {
        throw new Error(
          `--days-ahead must be a whole number from 0 to 31, got "${values['days-ahead']}"`,
        );
      }
    }
    return {
      retentionDays: parseRetentionDays(env.TELEMETRY_RETENTION_DAYS),
      daysAhead,
      every: parseEvery(values.every),
    };
  },
  async run(db, { retentionDays, daysAhead }, _resources, now) {
    return describeMaintenance(
      await runPartitionMaintenance(db, { retentionDays, daysAhead, now }),
    );
  },
};
