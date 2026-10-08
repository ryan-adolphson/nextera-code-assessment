import {
  MAX_QUERY_RANGE_DAYS,
  alertsInRange,
  type AlertLevel,
  type TelemetryResponse,
} from '@nextera/shared';
import { defineTool, describeAlerts, timestamp } from './tool.js';

/** Readings listed per turbine (newest first); the counts always cover every flagged reading. */
export const MAX_READINGS_PER_TURBINE = 50;

const LEVELS_WORST_FIRST: readonly AlertLevel[] = ['error', 'warn', 'info'];

interface TurbineAlerts {
  turbineId: string;
  farmId: string;
  worstLevel: AlertLevel;
  /** Rule triggers per level (a reading can trigger several rules). */
  levelCounts: Record<AlertLevel, number>;
  flaggedReadings: number;
  latestAlert: string;
  readings: { timestamp: string; alerts: string[] }[];
  /** Flagged readings not listed (older than the newest MAX_READINGS_PER_TURBINE). */
  omittedReadings: number;
}

/** Groups flagged readings (by turbine, newest first, as `alertsInRange` returns them). */
export function groupByTurbine(readings: TelemetryResponse[]): TurbineAlerts[] {
  const groups = new Map<string, TurbineAlerts>();
  for (const reading of readings) {
    let group = groups.get(reading.turbineId);
    if (!group) {
      group = {
        turbineId: reading.turbineId,
        farmId: reading.farmId,
        worstLevel: 'info',
        levelCounts: { error: 0, warn: 0, info: 0 },
        flaggedReadings: 0,
        latestAlert: reading.timestamp, // newest first
        readings: [],
        omittedReadings: 0,
      };
      groups.set(reading.turbineId, group);
    }
    group.flaggedReadings++;
    for (const rule of reading.alerts) group.levelCounts[rule.alertLevel]++;
    if (group.readings.length < MAX_READINGS_PER_TURBINE) {
      group.readings.push({
        timestamp: reading.timestamp,
        alerts: describeAlerts(reading),
      });
    } else {
      group.omittedReadings++;
    }
  }
  for (const group of groups.values()) {
    group.worstLevel =
      LEVELS_WORST_FIRST.find((level) => group.levelCounts[level] > 0) ??
      'info';
  }
  return [...groups.values()];
}

export const listAlertsTool = defineTool({
  name: 'list_alerts',
  title: 'List triggered alerts',
  description:
    'Readings measured in [from, to) (at most ' +
    `${MAX_QUERY_RANGE_DAYS} days) that triggered alert rules at ingestion, grouped by turbine: ` +
    'the worst level (error > warn > info), rule triggers per level, the number of flagged ' +
    `readings, and the newest ${MAX_READINGS_PER_TURBINE} flagged readings with each rule as ` +
    '"level: metric value comparison threshold". Rules show as they are now; a rule disabled ' +
    'since is still listed on the readings it flagged.',
  inputSchema: {
    from: timestamp('from', 'Inclusive lower bound on measurement time.'),
    to: timestamp(
      'to',
      'Exclusive upper bound on measurement time (may be in the future).',
    ),
  },
  async run({ db }, { from, to }) {
    const readings = await alertsInRange(db, { from, to });
    const turbines = groupByTurbine(readings);
    return {
      from,
      to,
      flaggedReadings: readings.length,
      turbineCount: turbines.length,
      turbines,
    };
  },
});
