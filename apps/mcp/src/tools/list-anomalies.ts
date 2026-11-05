import {
  ANOMALY_MIN_READINGS,
  LOW_POWER_MIN_WIND_MS,
  STUCK_SENSOR_MIN_POWER_RANGE_KW,
  STUCK_SENSOR_MIN_READINGS,
  MAX_QUERY_RANGE_DAYS,
  anomaliesInRange,
} from '@nextera/shared';
import { defineTool, timestamp } from './tool.js';

/** Episodes listed (newest first); the total and the lost-output sum always cover all of them. */
export const MAX_ANOMALIES_LISTED = 100;

export const listAnomaliesTool = defineTool({
  name: 'list_anomalies',
  title: 'List detected anomalies',
  description:
    `Anomaly episodes in [from, to) (at most ${MAX_QUERY_RANGE_DAYS} days), detected by an hourly job (they can lag the readings by up to an hour) ` +
    'beyond the static alert thresholds; the same data as GET /api/anomalies. Consecutive means ' +
    'no gap in the turbine\'s readings. Episodes crossing the range are clipped to it. "low_power_in_wind": at least ' +
    `${ANOMALY_MIN_READINGS} consecutive readings with wind >= ${LOW_POWER_MIN_WIND_MS} m/s but ` +
    'power under 10 % of the fleet median power at that wind (a fleet-derived estimate, not a ' +
    'manufacturer curve), with estimatedLostKwh. "stuck_sensor": the same gearboxTempC, ' +
    `windSpeedMs or rotorRpm value (\`value\`) for at least ${STUCK_SENSOR_MIN_READINGS} ` +
    "consecutive readings (1 hour) while the turbine's power range over them is at least " +
    `${STUCK_SENSOR_MIN_POWER_RANGE_KW} kW (flat power too means a plateau or a stopped turbine, ` +
    'not a sensor fault). Turbines that stopped reporting are not anomalies (use get_turbine ' +
    `staleness). Newest first, the newest ${MAX_ANOMALIES_LISTED} listed; ` +
    'totalEpisodes and estimatedLostKwh cover all (up to 5,000 episodes; truncated says more exist).',
  inputSchema: {
    from: timestamp('from', 'Inclusive lower bound on measurement time.'),
    to: timestamp(
      'to',
      'Exclusive upper bound on measurement time (may be in the future).',
    ),
  },
  async run({ db }, { from, to }) {
    const result = await anomaliesInRange(db, { from, to });
    return {
      ...result,
      totalEpisodes: result.anomalies.length,
      anomalies: result.anomalies.slice(0, MAX_ANOMALIES_LISTED),
      omittedEpisodes: Math.max(
        0,
        result.anomalies.length - MAX_ANOMALIES_LISTED,
      ),
    };
  },
});
