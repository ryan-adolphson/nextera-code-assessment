import {
  MAX_QUERY_RANGE_DAYS,
  farmWeather,
  type WeatherDayResponse,
  type WeatherHourResponse,
  type WeatherInterval,
  type WeatherSource,
} from '@nextera/shared';
import { z } from 'zod';
import { businessKey, defineTool, timestamp } from './tool.js';

/** Hourly values in this order (the API's field names carry the unit). */
export const HOURLY_COLUMNS = [
  'time',
  'source',
  'windSpeed10mMs',
  'windSpeed100mMs',
  'windDirection10mDeg',
  'windDirection100mDeg',
  'windGusts10mMs',
  'temperature2mC',
  'relativeHumidity2mPct',
  'surfacePressureHpa',
  'precipitationMm',
  'cloudCoverPct',
] as const satisfies readonly (keyof WeatherHourResponse)[];

/** Daily values in this order. */
export const DAILY_COLUMNS = [
  'date',
  'hours',
  'source',
  'windSpeed10mMeanMs',
  'windSpeed10mMaxMs',
  'windSpeed100mMeanMs',
  'windSpeed100mMaxMs',
  'windGusts10mMaxMs',
  'windDirection100mDeg',
  'temperature2mMinC',
  'temperature2mMaxC',
  'temperature2mMeanC',
  'relativeHumidity2mMeanPct',
  'surfacePressureMeanHpa',
  'precipitationSumMm',
  'cloudCoverMeanPct',
] as const satisfies readonly (keyof WeatherDayResponse)[];

const INTERVALS = [
  'hourly',
  'daily',
] as const satisfies readonly WeatherInterval[];

export const getWeatherTool = defineTool({
  name: 'get_weather',
  title: 'Get farm weather',
  description:
    'A wind farm’s weather from Open-Meteo at the farm’s coordinates (one series per farm, not ' +
    `per turbine) in [from, to) (at most ${MAX_QUERY_RANGE_DAYS} days), oldest first, UTC. ` +
    'daily (default): one row per UTC day aggregated from the stored hours (wind means/maxima, ' +
    'vector-mean 100 m direction, temperature min/max/mean, precipitation sum, `hours` covered, ' +
    '24 for a complete day); hourly: one row per hour, `time` = the start of the UTC hour. ' +
    'Values in the order of `columns`; units are in the names (Ms = m/s, Deg, C, Pct, Hpa, Mm); ' +
    'null = not reported. `source` is archive (final reanalysis) or forecast (the most recent ' +
    'days, replaced by the archive later); a day is forecast if any of its hours is. No rows ' +
    'means the weather was not synced for that range, not calm weather. For power-vs-weather ' +
    'analysis, pair it with get_telemetry (a turbine’s windSpeedMs is measured at the hub, ' +
    'closest to windSpeed100mMs); get_turbine gives a turbine’s farm.',
  inputSchema: {
    farmId: businessKey('The farm id, e.g. "FARM01".'),
    from: timestamp('from', 'Inclusive lower bound on the hour’s start time.'),
    to: timestamp(
      'to',
      'Exclusive upper bound on the hour’s start time (may be in the future).',
    ),
    interval: z
      .enum(INTERVALS)
      .default('daily')
      .describe(
        'daily (default): one row per UTC day; hourly: one row per hour (up to 744 rows for ' +
          '31 days).',
      ),
  },
  async run({ db }, { farmId, from, to, interval }) {
    const weather = await farmWeather(db, farmId, { from, to, interval });
    const sources: Record<WeatherSource, number> = { archive: 0, forecast: 0 };
    for (const point of weather.points) sources[point.source]++;
    const base = {
      farmId: weather.farmId,
      from: weather.from,
      to: weather.to,
      interval: weather.interval,
      count: weather.points.length,
      sources,
    };
    if (weather.interval === 'hourly') {
      return {
        ...base,
        columns: HOURLY_COLUMNS,
        rows: weather.points.map((p) => HOURLY_COLUMNS.map((c) => p[c])),
      };
    }
    return {
      ...base,
      columns: DAILY_COLUMNS,
      rows: weather.points.map((p) => DAILY_COLUMNS.map((c) => p[c])),
    };
  },
});
