import { Prisma } from '../generated/prisma/client.js';
import {
  toTelemetryResponse,
  toTelemetryStatsResponse,
  toTurbineResponse,
  toWeatherDayResponse,
  toWeatherHalfHourResponse,
} from './responses.js';

describe('toTurbineResponse', () => {
  const turbine = {
    id: '3f1c9a4e-7b2d-4c5e-9f10-2a3b4c5d6e7f',
    turbineId: 'TURB001',
    farmId: 'FARM01',
    latitude: new Prisma.Decimal('41.251234'),
    longitude: new Prisma.Decimal('-96.531'),
    commissioned: false,
  };

  it('exposes the business key as id (never the internal UUID), numbers and the commissioned flag', () => {
    expect(toTurbineResponse(turbine)).toEqual({
      id: 'TURB001',
      farmId: 'FARM01',
      latitude: 41.251234,
      longitude: -96.531,
      commissioned: false,
    });
  });

  it('maps commissioned turbines', () => {
    expect(
      toTurbineResponse({ ...turbine, commissioned: true }).commissioned,
    ).toBe(true);
  });
});

// The SQL that produces these rows runs against a real Postgres in apps/api/test/fleet.e2e-spec.ts.
describe('toTelemetryStatsResponse', () => {
  const row = {
    count: 3n, // count(*) is bigint unless cast
    first_timestamp: new Date('2026-01-02T03:20:00Z'),
    last_timestamp: new Date('2026-01-02T03:30:00Z'),
    power_output_kw_median: 2200,
    power_output_kw_high: 2250.5,
    power_output_kw_low: 2100,
    wind_speed_ms_median: '8.5', // numeric columns can arrive as strings
    wind_speed_ms_high: 9,
    wind_speed_ms_low: 8,
    rotor_rpm_median: 13,
    rotor_rpm_high: 13.5,
    rotor_rpm_low: 12.5,
    blade_pitch_deg_median: 4,
    blade_pitch_deg_high: 4.5,
    blade_pitch_deg_low: 3.5,
    gearbox_temp_c_median: 126.5,
    gearbox_temp_c_high: 126.5,
    gearbox_temp_c_low: 126.5,
  };

  it('maps each metric’s median/high/low to plain numbers and the span to ISO strings', () => {
    expect(toTelemetryStatsResponse('TURB002', row)).toEqual({
      turbineId: 'TURB002',
      from: '2026-01-02T03:20:00.000Z',
      to: '2026-01-02T03:30:00.000Z',
      count: 3,
      metrics: {
        powerOutputKw: { median: 2200, high: 2250.5, low: 2100 },
        windSpeedMs: { median: 8.5, high: 9, low: 8 },
        rotorRpm: { median: 13, high: 13.5, low: 12.5 },
        bladePitchDeg: { median: 4, high: 4.5, low: 3.5 },
        gearboxTempC: { median: 126.5, high: 126.5, low: 126.5 },
      },
    });
  });

  it('returns count 0 and null stats for an empty window', () => {
    expect(
      toTelemetryStatsResponse('TURB001', {
        count: 0,
        first_timestamp: null,
        last_timestamp: null,
      }),
    ).toEqual({
      turbineId: 'TURB001',
      from: null,
      to: null,
      count: 0,
      metrics: {
        powerOutputKw: null,
        windSpeedMs: null,
        rotorRpm: null,
        bladePitchDeg: null,
        gearboxTempC: null,
      },
    });
  });
});

describe('toTelemetryResponse', () => {
  const reading = {
    id: 'f2b6c0de-0000-4000-8000-000000000001',
    turbineId: 'TURB001',
    farmId: 'FARM01',
    timestamp: new Date('2026-01-02T23:55:00.000Z'),
    receivedAt: new Date('2026-01-02T23:57:00.000Z'),
    createdAt: new Date('2026-01-02T23:57:01.000Z'),
    powerOutputKw: 40,
    windSpeedMs: 8.5,
    rotorRpm: 12,
    bladePitchDeg: 4,
    gearboxTempC: 126.5,
  };
  const rule = (
    id: string,
    alertLevel: 'info' | 'warn' | 'error',
    measurementMetric: 'gearboxTempC' | 'powerOutputKw' = 'gearboxTempC',
  ) => ({
    id,
    measurementMetric,
    comparison: 'above' as const,
    valueMetric: 1,
    alertLevel,
    enabled: true,
  });

  it('maps the reading with no alerts to an empty list', () => {
    expect(toTelemetryResponse({ ...reading, alerts: [] })).toEqual({
      id: reading.id,
      turbineId: 'TURB001',
      farmId: 'FARM01',
      timestamp: '2026-01-02T23:55:00.000Z',
      receivedAt: '2026-01-02T23:57:00.000Z',
      powerOutputKw: 40,
      windSpeedMs: 8.5,
      rotorRpm: 12,
      bladePitchDeg: 4,
      gearboxTempC: 126.5,
      alerts: [],
    });
  });

  it('joins in each triggered rule as an AlertConfigResponse, worst level first', () => {
    const { alerts } = toTelemetryResponse({
      ...reading,
      alerts: [
        { alert: rule('a', 'info') },
        { alert: rule('b', 'error') },
        { alert: rule('c', 'warn', 'powerOutputKw') },
      ],
    });
    expect(alerts.map((a) => [a.id, a.alertLevel])).toEqual([
      ['b', 'error'],
      ['c', 'warn'],
      ['a', 'info'],
    ]);
    expect(alerts[0]).toEqual({ ...rule('b', 'error') });
  });
});

describe('toWeatherDayResponse', () => {
  const row = {
    day: '2026-01-01',
    samples: 48n,
    wind_speed_10m_mean: 5.123456,
    wind_speed_10m_max: '9.5',
    wind_speed_80m_mean: 8,
    wind_speed_80m_max: 12,
    wind_direction_80m: 359.9999999,
    wind_gusts_10m_max: 14.2,
    temperature_2m_min: -1,
    temperature_2m_max: 4,
    temperature_2m_mean: 1.5,
    relative_humidity_2m_mean: 80,
    surface_pressure_mean: 990.25,
    precipitation_sum: null,
    cloud_cover_mean: 50,
  };

  it('keeps the local day, rounds to 2 decimals and keeps nulls, in the contract order', () => {
    const day = toWeatherDayResponse(row);
    expect(day).toEqual({
      date: '2026-01-01',
      samples: 48,
      windSpeed10mMeanMs: 5.12,
      windSpeed10mMaxMs: 9.5,
      windSpeed80mMeanMs: 8,
      windSpeed80mMaxMs: 12,
      windDirection80mDeg: 0, // 360 is north
      windGusts10mMaxMs: 14.2,
      temperature2mMinC: -1,
      temperature2mMaxC: 4,
      temperature2mMeanC: 1.5,
      relativeHumidity2mMeanPct: 80,
      surfacePressureMeanHpa: 990.25,
      precipitationSumMm: null,
      cloudCoverMeanPct: 50,
    });
    expect(Object.keys(day)).toEqual([
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
    ]);
  });
});

describe('toWeatherHalfHourResponse', () => {
  it('maps a bucket without farm_id and fetched_at, in the contract order', () => {
    const point = toWeatherHalfHourResponse({
      farmId: 'FARM01',
      time: new Date('2026-01-01T00:30:00Z'),
      samples: 2,
      windSpeed10mMs: 4.28,
      windSpeed80mMs: 10.67,
      windDirection10mDeg: 332,
      windDirection80mDeg: 334.5,
      windGusts10mMs: 9.2,
      temperature2mC: 6.85,
      relativeHumidity2mPct: 47,
      surfacePressureHpa: 968.55,
      precipitationMm: null,
      cloudCoverPct: 0,
      fetchedAt: new Date(),
    });
    expect(Object.keys(point)).toEqual([
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
    ]);
    expect(point).toMatchObject({
      time: '2026-01-01T00:30:00.000Z',
      samples: 2,
      precipitationMm: null,
    });
  });
});
