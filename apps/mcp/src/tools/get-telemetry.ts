import { TELEMETRY_METRICS, turbineTelemetry } from '@nextera/shared';
import { businessKey, defineTool, describeAlerts } from './tool.js';
import { telemetryWindow } from './window.js';

const COLUMNS = ['timestamp', ...TELEMETRY_METRICS, 'alerts'] as const;

export const getTelemetryTool = defineTool({
  name: 'get_telemetry',
  title: 'Get turbine telemetry',
  description:
    'A turbine’s readings, newest first: measured in [from, to) (both optional), at most ' +
    '`limit`. One row per reading, values in the order of `columns`: measurement time (UTC), ' +
    'power kW, wind m/s, rotor rpm, blade pitch °, gearbox °C, and the alert rules it triggered. ' +
    'For trends over long windows prefer get_telemetry_stats or get_report_summary.',
  inputSchema: {
    turbineId: businessKey('The turbine id, e.g. "TURB002".'),
    ...telemetryWindow,
  },
  async run({ db }, { turbineId, from, to, limit }) {
    const readings = await turbineTelemetry(db, turbineId, { from, to, limit });
    return {
      turbineId,
      count: readings.length,
      columns: COLUMNS,
      rows: readings.map((r) => [
        r.timestamp,
        ...TELEMETRY_METRICS.map((metric) => r[metric]),
        describeAlerts(r),
      ]),
    };
  },
});
