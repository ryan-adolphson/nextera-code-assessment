import { telemetryStats } from '@nextera/shared';
import { businessKey, defineTool } from './tool.js';
import { telemetryWindow } from './window.js';

export const getTelemetryStatsTool = defineTool({
  name: 'get_telemetry_stats',
  title: 'Get turbine telemetry statistics',
  description:
    'Median, high and low of every metric (power kW, wind m/s, rotor rpm, blade pitch °, ' +
    'gearbox °C) over exactly the readings get_telemetry returns for the same turbineId, ' +
    'from, to and limit, computed in Postgres; with the count and the oldest/newest ' +
    'measurement time covered. Metrics are null when there are no readings.',
  inputSchema: {
    turbineId: businessKey('The turbine id, e.g. "TURB002".'),
    ...telemetryWindow,
  },
  run({ db }, { turbineId, from, to, limit }) {
    return telemetryStats(db, turbineId, { from, to, limit });
  },
});
