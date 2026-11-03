import { TELEMETRY_METRICS, toFarmDayResponse } from './responses.js';
import { FARM_ROLLUP_METRICS, floorToBucket } from './farm-rollup.js';

describe('farm rollup helpers', () => {
  it('floors to the 30-minute UTC bucket', () => {
    expect(floorToBucket(new Date('2026-11-01T10:29:59.999Z'))).toEqual(
      new Date('2026-11-01T10:00:00Z'),
    );
    expect(floorToBucket(new Date('2026-11-01T10:30:00Z'))).toEqual(
      new Date('2026-11-01T10:30:00Z'),
    );
  });

  it('describes every telemetry metric: power summed, the others averaged', () => {
    expect(Object.keys(FARM_ROLLUP_METRICS)).toEqual([...TELEMETRY_METRICS]);
    expect(
      Object.values(FARM_ROLLUP_METRICS).map((m) => [m.prefix, m.combine]),
    ).toEqual([
      ['power', 'sum'],
      ['wind_speed', 'avg'],
      ['rotor_rpm', 'avg'],
      ['blade_pitch', 'avg'],
      ['gearbox_temp', 'avg'],
    ]);
  });
});

describe('toFarmDayResponse', () => {
  it('maps a daily row to OHLC per metric, rounded to 2 decimals, counts as numbers', () => {
    const row = {
      day: '2026-11-01',
      turbines: 20,
      readings: BigInt(5760),
      computed_at: new Date(),
      ...Object.fromEntries(
        Object.values(FARM_ROLLUP_METRICS).flatMap(({ prefix }, i) => [
          [`${prefix}_open`, i + 0.123],
          [`${prefix}_close`, i + 0.456],
          [`${prefix}_high`, i + 10.999],
          [`${prefix}_low`, -i - 0.001],
        ]),
      ),
    };
    expect(toFarmDayResponse(row)).toEqual({
      date: '2026-11-01',
      turbines: 20,
      readings: 5760,
      powerOutputKw: { open: 0.12, close: 0.46, high: 11, low: -0 },
      windSpeedMs: { open: 1.12, close: 1.46, high: 12, low: -1 },
      rotorRpm: { open: 2.12, close: 2.46, high: 13, low: -2 },
      bladePitchDeg: { open: 3.12, close: 3.46, high: 14, low: -3 },
      gearboxTempC: { open: 4.12, close: 4.46, high: 15, low: -4 },
    });
  });
});
