import { anomalyDuration, anomalyWindow, formatEnergy, stuckText } from './anomaly.model';

describe('anomaly model', () => {
  it('windows the 7 days ending at the clock', () => {
    expect(anomalyWindow(Date.parse('2026-01-08T12:00:30.000Z'))).toEqual({
      from: '2026-01-01T12:00:30.000Z',
      to: '2026-01-08T12:00:30.000Z',
    });
  });

  it.each([
    ['2026-01-01T13:40:00Z', '2026-01-01T13:50:00Z', '15 min'],
    ['2026-01-01T13:40:00Z', '2026-01-01T14:40:00Z', '1 h 5 min'],
    ['2026-01-01T13:40:00Z', '2026-01-01T14:35:00Z', '1 h'],
    ['2026-01-01T13:40:00Z', '2026-01-02T15:35:00Z', '1 d 2 h'],
    ['2026-01-01T13:40:00Z', '2026-01-01T13:40:00Z', '5 min'],
  ])('measures %s to %s as %s (end plus one interval)', (start, end, text) => {
    expect(anomalyDuration({ start, end })).toBe(text);
  });

  it('words what the sensor is stuck at', () => {
    expect(stuckText({ metric: 'gearboxTempC', value: 126.5 })).toBe(
      'Gearbox temperature stuck at 126.5 °C',
    );
    expect(stuckText({ metric: 'rotorRpm', value: 12 })).toBe('Rotor speed stuck at 12.0 rpm');
    expect(stuckText({ metric: null, value: null })).toBe('Sensor stuck');
    expect(stuckText({ metric: 'windSpeedMs', value: null })).toBe('Sensor stuck');
  });

  it('formats kWh under 1,000 and MWh above', () => {
    expect(formatEnergy(849.6)).toBe('850 kWh');
    expect(formatEnergy(0)).toBe('0 kWh');
    expect(formatEnergy(1000)).toBe('1.0 MWh');
    expect(formatEnergy(12_345)).toBe('12.3 MWh');
  });
});
