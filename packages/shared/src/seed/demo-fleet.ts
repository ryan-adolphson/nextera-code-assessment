import type {
  AlertComparison,
  AlertLevel,
  MeasurementMetric,
} from '../generated/prisma/enums.js';

/**
 * The demo fleet (`npm run db:seed:demo` and `npm run demo:feed` only; the fixture CSVs in
 * prisma/data are untouched): 25 turbines, 2–3 on each of the 10 fixture farms. TURB001 and
 * TURB002 are the fixture's turbines with the same farm and coordinates.
 */
export interface DemoTurbine {
  turbineId: string;
  farmId: string;
  latitude: number;
  longitude: number;
  /** Set when the seed creates the turbine; an existing turbine's flag is never changed. */
  commissioned: boolean;
}

export const DEMO_TURBINES: readonly DemoTurbine[] = [
  // FARM01 Prairie Ridge
  t('TURB001', 'FARM01', 41.263, -96.518, false),
  t('TURB003', 'FARM01', 41.241, -96.544, true),
  t('TURB004', 'FARM01', 41.257, -96.551, true),
  // FARM02 High Plains
  t('TURB002', 'FARM02', 39.741, -101.207, false),
  t('TURB005', 'FARM02', 39.762, -101.229, true),
  t('TURB006', 'FARM02', 39.738, -101.241, true),
  // FARM03 Red Canyon
  t('TURB007', 'FARM03', 35.131, -106.538, true),
  t('TURB008', 'FARM03', 35.108, -106.567, true),
  // FARM04 Buffalo Creek
  t('TURB009', 'FARM04', 44.991, -103.428, true),
  t('TURB010', 'FARM04', 44.972, -103.452, true),
  t('TURB011', 'FARM04', 44.985, -103.461, true),
  // FARM05 Blue Sky
  t('TURB012', 'FARM05', 31.893, -102.158, false),
  t('TURB013', 'FARM05', 31.869, -102.183, true),
  // FARM06 Cedar Valley
  t('TURB014', 'FARM06', 42.124, -93.607, true),
  t('TURB015', 'FARM06', 42.101, -93.631, true),
  t('TURB016', 'FARM06', 42.118, -93.638, true),
  // FARM07 Mesa Wind
  t('TURB017', 'FARM07', 34.733, -111.818, true),
  t('TURB018', 'FARM07', 34.709, -111.844, true),
  // FARM08 Great Divide
  t('TURB019', 'FARM08', 46.231, -112.427, true),
  t('TURB020', 'FARM08', 46.208, -112.455, true),
  // FARM09 Rolling Hills
  t('TURB021', 'FARM09', 38.923, -98.104, true),
  t('TURB022', 'FARM09', 38.897, -98.131, true),
  t('TURB023', 'FARM09', 38.915, -98.139, true),
  // FARM10 Coastal Breeze
  t('TURB024', 'FARM10', 36.563, -121.906, true),
  t('TURB025', 'FARM10', 36.538, -121.934, false),
];

/** Seed of the demo generator: the seed and the live feed must use the same one. */
export const DEMO_SEED = 20261008;

/**
 * Alert rules the demo seed makes sure exist (created only where no rule for the same metric,
 * comparison and level exists yet; existing rules are never changed). With the generator's
 * normal ranges (wind 3–~17 m/s → power ≥ ~250 kW, pitch ≤ 6°, gearbox ≤ ~91 °C) only the
 * anomalies trigger them:
 * - gearbox above 100 °C → error: the gearbox stuck at 126.5 °C;
 * - power below 100 kW → warn: the stop at 0 kW in 15.8 m/s wind;
 * - pitch above 30° → info: the 44° pitch spike.
 */
export const DEMO_ALERT_RULES: readonly {
  measurementMetric: MeasurementMetric;
  comparison: AlertComparison;
  valueMetric: number;
  alertLevel: AlertLevel;
}[] = [
  {
    measurementMetric: 'gearboxTempC',
    comparison: 'above',
    valueMetric: 100,
    alertLevel: 'error',
  },
  {
    measurementMetric: 'powerOutputKw',
    comparison: 'below',
    valueMetric: 100,
    alertLevel: 'warn',
  },
  {
    measurementMetric: 'bladePitchDeg',
    comparison: 'above',
    valueMetric: 30,
    alertLevel: 'info',
  },
];

function t(
  turbineId: string,
  farmId: string,
  latitude: number,
  longitude: number,
  commissioned: boolean,
): DemoTurbine {
  return { turbineId, farmId, latitude, longitude, commissioned };
}
