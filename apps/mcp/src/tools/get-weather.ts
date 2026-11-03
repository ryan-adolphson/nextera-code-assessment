import {
  DEFAULT_WEATHER_TIME_ZONE,
  MAX_QUERY_RANGE_DAYS,
  farmWeather,
  turbineWeather,
  type WeatherDayResponse,
  type WeatherHalfHourResponse,
  type WeatherInterval,
} from '@nextera/shared';
import { z } from 'zod';
import { businessKey, defineTool, timestamp } from './tool.js';

/** 30-minute values in this order (the API's field names carry the unit). */
export const HALF_HOUR_COLUMNS = [
  'time',
  'samples',
  'windSpeed10mMs',
  'windSpeed80mMs',
  'windDirection10mDeg',
  'windDirection80mDeg',
  'windGusts10mMs',
  'temperature2mC',
  'relativeHumidity2mPct',
  'surfacePressureHpa',
  'precipitationMm',
  'cloudCoverPct',
] as const satisfies readonly (keyof WeatherHalfHourResponse)[];

/** Daily values in this order. */
export const DAILY_COLUMNS = [
  'date',
  'samples',
  'windSpeed10mMeanMs',
  'windSpeed10mMaxMs',
  'windSpeed80mMeanMs',
  'windSpeed80mMaxMs',
  'windDirection80mDeg',
  'windGusts10mMaxMs',
  'temperature2mMinC',
  'temperature2mMaxC',
  'temperature2mMeanC',
  'relativeHumidity2mMeanPct',
  'surfacePressureMeanHpa',
  'precipitationSumMm',
  'cloudCoverMeanPct',
] as const satisfies readonly (keyof WeatherDayResponse)[];

const INTERVALS = [
  '30min',
  'daily',
] as const satisfies readonly WeatherInterval[];

export const ONE_SUBJECT = 'Provide exactly one of farmId or turbineId';

export const getWeatherTool = defineTool({
  name: 'get_weather',
  title: 'Get farm or turbine weather',
  description:
    'Open-Meteo weather (forecast models at 15-minute resolution, aggregated into 30-minute ' +
    'buckets) at a wind farm’s coordinates, in [from, to) (at most ' +
    `${MAX_QUERY_RANGE_DAYS} days), oldest first. Give exactly one of farmId and turbineId: a ` +
    'turbine has no weather of its own and gets its current farm’s (one series per farm). ' +
    'daily (default): one row per day in timeZone (default UTC; local days, so a DST day has ' +
    '46 or 50 buckets) aggregated from the buckets (wind means/maxima, vector-mean 80 m ' +
    'direction, temperature min/max/mean, precipitation sum; `samples` = buckets covered, 48 for ' +
    'a complete day); 30min: one row per bucket, `time` = its UTC start (:00 or :30), `samples` = ' +
    '15-minute values in it (2 when complete). Values in the order of `columns`; units are in ' +
    'the names (Ms = m/s, Deg, C, Pct, Hpa, Mm); null = not reported. No rows means the weather ' +
    'was not synced for that range, not calm weather. 80 m is the level closest to hub height: ' +
    'for power-vs-weather analysis compare windSpeed80mMs with get_telemetry’s windSpeedMs ' +
    '(measured at the hub).',
  inputSchema: {
    farmId: businessKey(
      'A farm id, e.g. "FARM01" (or give turbineId).',
    ).optional(),
    turbineId: businessKey(
      'A turbine id, e.g. "TURB001" (or give farmId): its current farm’s weather.',
    ).optional(),
    from: timestamp(
      'from',
      'Inclusive lower bound on the bucket’s start time.',
    ),
    to: timestamp(
      'to',
      'Exclusive upper bound on the bucket’s start time (may be in the future).',
    ),
    interval: z
      .enum(INTERVALS)
      .default('daily')
      .describe(
        'daily (default): one row per day in timeZone; 30min: one row per 30-minute UTC ' +
          'bucket (up to 1488 rows for 31 days).',
      ),
    timeZone: z
      .string()
      .min(1)
      .max(64)
      .default(DEFAULT_WEATHER_TIME_ZONE)
      .describe(
        'IANA time zone of the daily rows, e.g. "America/Chicago" (default "UTC"). Ignored ' +
          'by 30min, whose times are UTC.',
      ),
  },
  refine: ({ farmId, turbineId }) =>
    (farmId === undefined) === (turbineId === undefined)
      ? ONE_SUBJECT
      : undefined,
  async run({ db }, { farmId, turbineId, ...query }) {
    const weather =
      turbineId !== undefined
        ? await turbineWeather(db, turbineId, query)
        : await farmWeather(db, farmId!, query);
    const base = {
      farmId: weather.farmId,
      ...('turbineId' in weather && { turbineId: weather.turbineId }),
      from: weather.from,
      to: weather.to,
      interval: weather.interval,
      timeZone: weather.timeZone,
      count: weather.points.length,
    };
    if (weather.interval === '30min') {
      return {
        ...base,
        columns: HALF_HOUR_COLUMNS,
        rows: weather.points.map((p) => HALF_HOUR_COLUMNS.map((c) => p[c])),
      };
    }
    return {
      ...base,
      columns: DAILY_COLUMNS,
      rows: weather.points.map((p) => DAILY_COLUMNS.map((c) => p[c])),
    };
  },
});
