import {
  DEFAULT_TELEMETRY_LIMIT,
  MAX_TELEMETRY_LIMIT,
  TELEMETRY_METRICS,
  UnallocatedStatus,
  getUnallocated,
  heldReadings,
  listUnallocated,
  type HeldReadingResponse,
  type UnallocatedTurbineResponse,
} from '@nextera/shared';
import { z } from 'zod';
import { businessKey, defineTool } from './tool.js';

/**
 * An entry for the model. `blockedBy` (the blocking user's email) is left out: the API shows it
 * only to owners, and this server has no users, so it doesn't hand out personal data.
 */
export function compactUnallocated(
  entry: UnallocatedTurbineResponse,
  nowMs: number,
) {
  return {
    id: entry.id,
    turbineId: entry.turbineId,
    kind: entry.kind,
    status: entry.status,
    reportedFarmId: entry.reportedFarmId,
    reportedFarm: entry.reportedFarm,
    currentFarm: entry.currentFarm,
    firstSeenAt: entry.firstSeenAt,
    lastSeenAt: entry.lastSeenAt,
    minutesSinceLastSeen: Math.max(
      0,
      Math.floor((nowMs - Date.parse(entry.lastSeenAt)) / 60_000),
    ),
    heldCount: entry.heldCount,
    latest: entry.latest && compactHeld(entry.latest),
    blockedAt: entry.blockedAt,
  };
}

/** A held reading without the ids its entry already gives (turbine, reported farm). */
const compactHeld = (reading: HeldReadingResponse) => ({
  timestamp: reading.timestamp,
  receivedAt: reading.receivedAt,
  ...Object.fromEntries(TELEMETRY_METRICS.map((m) => [m, reading[m]])),
});

export const listUnallocatedTool = defineTool({
  name: 'list_unallocated',
  title: 'List unallocated turbines',
  description:
    'Readings ingestion holds instead of storing, one entry per (turbine id, reported farm): ' +
    'kind unknown_turbine (the turbine id is not in the fleet, so list_farms and get_turbine ' +
    'don’t know it) or farm_mismatch (the turbine exists, on currentFarm, but the readings ' +
    'report another farm; reportedFarm is null when no farm has that id). pending (default): ' +
    'held readings (kept 7 days) waiting for an owner to assign, keep, move or block in the web ' +
    'app; blocked: further readings are dropped (heldCount 0). Each entry: first/last time a ' +
    'reading arrived, minutesSinceLastSeen, the held count and the newest held reading. ' +
    'Latest activity first. Use get_unallocated_readings with an entry’s id for its readings.',
  inputSchema: {
    status: z
      .enum(UnallocatedStatus)
      .default('pending')
      .describe('pending (default) or blocked.'),
    turbineId: businessKey(
      'Only this turbine id’s entries, e.g. "TURB099" (optional).',
    ).optional(),
  },
  async run({ db, now }, { status, turbineId }) {
    const entries = await listUnallocated(db, { status, turbineId });
    const asOf = now();
    return {
      asOf: new Date(asOf).toISOString(),
      status,
      count: entries.length,
      entries: entries.map((entry) => compactUnallocated(entry, asOf)),
    };
  },
});

const HELD_COLUMNS = ['timestamp', ...TELEMETRY_METRICS] as const;

export const getUnallocatedReadingsTool = defineTool({
  name: 'get_unallocated_readings',
  title: 'Get held readings of an unallocated turbine',
  description:
    'The held readings of one unallocated entry (its id from list_unallocated), newest first, ' +
    'at most `limit`, with the entry itself. One row per reading, values in the order of ' +
    '`columns`: measurement time (UTC), power kW, wind m/s, rotor rpm, blade pitch °, gearbox ' +
    '°C. Held readings are not evaluated against the alert rules until an owner imports them. ' +
    'A blocked entry has none.',
  inputSchema: {
    id: z
      .uuid({ error: 'id must be the UUID of an entry from list_unallocated' })
      .describe(
        'The entry id (a UUID) from list_unallocated, not the turbine id.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_TELEMETRY_LIMIT)
      .default(DEFAULT_TELEMETRY_LIMIT)
      .describe(
        `The newest N held readings (default ${DEFAULT_TELEMETRY_LIMIT} = 24 h at one reading ` +
          `per 5 minutes, max ${MAX_TELEMETRY_LIMIT}).`,
      ),
  },
  async run({ db, now }, { id, limit }) {
    const entry = await getUnallocated(db, id);
    const readings = await heldReadings(db, id, limit);
    return {
      entry: compactUnallocated(entry, now()),
      count: readings.length,
      columns: HELD_COLUMNS,
      rows: readings.map((r) => [
        r.timestamp,
        ...TELEMETRY_METRICS.map((metric) => r[metric]),
      ]),
    };
  },
});
