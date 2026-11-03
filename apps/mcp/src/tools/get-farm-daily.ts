import {
  DEFAULT_WEATHER_TIME_ZONE,
  MAX_FARM_DAILY_RANGE_DAYS,
  farmDailyHistory,
} from '@nextera/shared';
import { z } from 'zod';
import { businessKey, defineTool, timestamp } from './tool.js';

export const getFarmDailyTool = defineTool({
  name: 'get_farm_daily',
  title: 'Get a farm’s daily candles',
  description:
    'A wind farm’s telemetry as one candle per local day in timeZone (default UTC; a DST day ' +
    `is 23 or 25 hours), in [from, to) (at most ${MAX_FARM_DAILY_RANGE_DAYS} days), oldest ` +
    'first; the same data as GET /api/farms/:farmId/telemetry/daily. The farm series has one ' +
    'point per 5-minute timestamp: powerOutputKw is the SUM over the turbines that reported, ' +
    'windSpeedMs, rotorRpm, bladePitchDeg and gearboxTempC their MEAN. Per day and metric: ' +
    'open (first point), close (last point), high, low; `turbines` = the most that reported in ' +
    'any 30 minutes of the day (compare with turbineCount, the farm’s turbines now), ' +
    '`readings` = readings that day. Precomputed by a job every 15 minutes (computedAt = when ' +
    'it last wrote these days; null with no days): readings of the last minutes may be ' +
    'missing. Days without readings are omitted. Send from/to at local midnights of timeZone ' +
    'for whole days. For one turbine use get_telemetry / get_telemetry_stats.',
  inputSchema: {
    farmId: businessKey('A farm id, e.g. "FARM01".'),
    from: timestamp(
      'from',
      'Inclusive lower bound (a local midnight for whole days).',
    ),
    to: timestamp(
      'to',
      'Exclusive upper bound (a local midnight for whole days; may be in the future).',
    ),
    timeZone: z
      .string()
      .min(1)
      .max(64)
      .default(DEFAULT_WEATHER_TIME_ZONE)
      .describe(
        'IANA time zone of the days, e.g. "America/Chicago" (default "UTC").',
      ),
  },
  run({ db }, { farmId, ...query }) {
    return farmDailyHistory(db, farmId, query);
  },
});
