import { listFarms } from '@nextera/shared';
import { freshness, type TurbineStatus } from '../staleness.js';
import { compactReading, defineTool } from './tool.js';

export const listFarmsTool = defineTool({
  name: 'list_farms',
  title: 'List farms and turbines',
  description:
    'The whole fleet: every wind farm with its turbines and each turbine’s latest reading ' +
    '(power kW, wind m/s, rotor rpm, blade pitch °, gearbox °C, triggered alert rules). ' +
    'Each turbine has a status from the time since its latest measurement: ok, stale-15, ' +
    'stale-30, stale-60 (no data for more than 15/30/60 minutes) or no-data (never reported), ' +
    'and minutesSinceLatest. Use it for fleet health and "which turbines stopped reporting?".',
  inputSchema: {},
  async run({ db, now }) {
    const farms = await listFarms(db);
    const asOf = now();
    const statusCounts: Partial<Record<TurbineStatus, number>> = {};
    const result = farms.map((farm) => ({
      id: farm.id,
      name: farm.name,
      latitude: farm.latitude,
      longitude: farm.longitude,
      turbines: farm.turbines.map((turbine) => {
        const fresh = freshness(turbine.latest?.timestamp ?? null, asOf);
        statusCounts[fresh.status] = (statusCounts[fresh.status] ?? 0) + 1;
        return {
          id: turbine.id,
          commissioned: turbine.commissioned,
          ...fresh,
          latest: turbine.latest && compactReading(turbine.latest),
        };
      }),
    }));
    return {
      asOf: new Date(asOf).toISOString(),
      farmCount: farms.length,
      turbineCount: farms.reduce((n, f) => n + f.turbines.length, 0),
      statusCounts,
      farms: result,
    };
  },
});
