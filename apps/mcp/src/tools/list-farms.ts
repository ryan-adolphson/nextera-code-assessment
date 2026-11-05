import { listFarmSummaries } from '@nextera/shared';
import { defineTool } from './tool.js';

/** Farms listed (by id); the fleet totals always cover every farm. */
export const MAX_FARMS_LISTED = 200;

export const listFarmsTool = defineTool({
  name: 'list_farms',
  title: 'List farms with live totals',
  description:
    'The fleet at a glance: fleet totals and every wind farm (up to the first ' +
    `${MAX_FARMS_LISTED} by id; farmCount and the totals cover all) with its live totals: ` +
    'turbineCount, commissioned, reporting (newest reading at most 15 minutes old), stale ' +
    '(a reading, but older), noData (never reported), alerting (reporting turbines whose newest ' +
    'reading triggered an alert rule), total powerOutputKw and mean windSpeedMs of the ' +
    'reporting turbines. Totals are rebuilt about once a minute (asOf). It does not list ' +
    'turbines: use get_turbine for one (its latest reading and status), get_telemetry for its ' +
    'history, list_alerts and list_anomalies for what is wrong. Turbine ids that report but are ' +
    'not in the fleet are not counted: see list_unallocated.',
  inputSchema: {},
  async run({ db, now }) {
    const farms = await listFarmSummaries(db, { now: new Date(now()) });
    const totals = {
      turbines: 0,
      commissioned: 0,
      reporting: 0,
      stale: 0,
      noData: 0,
      alerting: 0,
      powerOutputKw: 0,
    };
    let asOf: string | null = null;
    for (const farm of farms) {
      totals.turbines += farm.turbineCount;
      totals.commissioned += farm.commissioned;
      totals.reporting += farm.reporting;
      totals.stale += farm.stale;
      totals.noData += farm.turbineCount - farm.reporting - farm.stale;
      totals.alerting += farm.alerting;
      totals.powerOutputKw += farm.powerOutputKw;
      if (farm.asOf && (asOf === null || farm.asOf < asOf)) asOf = farm.asOf;
    }
    return {
      asOf,
      farmCount: farms.length,
      ...totals,
      omittedFarms: Math.max(0, farms.length - MAX_FARMS_LISTED),
      farms: farms.slice(0, MAX_FARMS_LISTED).map((farm) => ({
        id: farm.id,
        name: farm.name,
        latitude: farm.latitude,
        longitude: farm.longitude,
        turbineCount: farm.turbineCount,
        commissioned: farm.commissioned,
        reporting: farm.reporting,
        stale: farm.stale,
        noData: farm.turbineCount - farm.reporting - farm.stale,
        alerting: farm.alerting,
        powerOutputKw: farm.powerOutputKw,
        windSpeedMs: farm.windSpeedMs,
      })),
    };
  },
});
