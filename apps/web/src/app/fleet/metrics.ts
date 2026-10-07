import { Telemetry } from './fleet.model';

/** A charted telemetry value (a numeric Telemetry field). */
export type Metric = keyof Pick<
  Telemetry,
  'powerOutputKw' | 'windSpeedMs' | 'rotorRpm' | 'bladePitchDeg' | 'gearboxTempC'
>;

/** One chart per measured value (small multiples sharing the time axis). */
export const METRICS: { key: Metric; title: string; unit: string; decimals: number }[] = [
  { key: 'powerOutputKw', title: 'Power output', unit: 'kW', decimals: 0 },
  { key: 'windSpeedMs', title: 'Wind speed', unit: 'm/s', decimals: 1 },
  { key: 'rotorRpm', title: 'Rotor speed', unit: 'rpm', decimals: 1 },
  { key: 'bladePitchDeg', title: 'Blade pitch', unit: '°', decimals: 1 },
  { key: 'gearboxTempC', title: 'Gearbox temperature', unit: '°C', decimals: 1 },
];
