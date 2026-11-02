import type {
  AlertComparison,
  AlertLevel,
  MeasurementMetric,
} from '../generated/prisma/enums.js';

/**
 * The demo fleet (`npm run db:seed:demo`, `npm run demo:reset` and the live demo feed only; the
 * fixture CSVs in prisma/data are untouched): 200 turbines, TURB001–TURB200, 16–24 on each of the
 * 10 fixture farms (DEMO_FARM_LAYOUT). TURB001–TURB025 are the original hand-placed demo turbines
 * (ORIGINAL_TURBINES, unchanged: same farm, coordinates and anomalies); TURB001 and TURB002 are the
 * fixture's turbines with the same farm and coordinates. TURB026–TURB200 are generated
 * (demoFleetTurbines): a contiguous block of ids per farm, on a staggered grid around the farm's
 * centre.
 */
export interface DemoTurbine {
  turbineId: string;
  farmId: string;
  latitude: number;
  longitude: number;
  /** Set when the seed creates the turbine; an existing turbine's flag is never changed. */
  commissioned: boolean;
}

const ORIGINAL_TURBINES: readonly DemoTurbine[] = [
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

/**
 * Each fixture farm's centre (farms.csv; a test checks they match) and how many demo turbines it
 * has in total, original ones included: 200 in all, deliberately uneven (16–24).
 */
export const DEMO_FARM_LAYOUT: readonly {
  farmId: string;
  latitude: number;
  longitude: number;
  turbines: number;
}[] = [
  { farmId: 'FARM01', latitude: 41.25, longitude: -96.53, turbines: 22 },
  { farmId: 'FARM02', latitude: 39.75, longitude: -101.22, turbines: 18 },
  { farmId: 'FARM03', latitude: 35.12, longitude: -106.55, turbines: 20 },
  { farmId: 'FARM04', latitude: 44.98, longitude: -103.44, turbines: 24 },
  { farmId: 'FARM05', latitude: 31.88, longitude: -102.17, turbines: 16 },
  { farmId: 'FARM06', latitude: 42.11, longitude: -93.62, turbines: 21 },
  { farmId: 'FARM07', latitude: 34.72, longitude: -111.83, turbines: 19 },
  { farmId: 'FARM08', latitude: 46.22, longitude: -112.44, turbines: 23 },
  { farmId: 'FARM09', latitude: 38.91, longitude: -98.12, turbines: 17 },
  { farmId: 'FARM10', latitude: 36.55, longitude: -121.92, turbines: 20 },
];

/** Grid of the generated turbines: rows 0.008° (~0.9 km) apart, 0.010° (~0.8 km) along a row. */
const GRID_COLUMNS = 5;
const ROW_STEP_DEG = 0.008;
const COLUMN_STEP_DEG = 0.01;
/** A grid slot this close (in degrees, ~250 m) to an original turbine is skipped. */
const MIN_SPACING_DEG = 0.0025;

/**
 * The whole demo fleet, deterministic: the original 25, then per farm (DEMO_FARM_LAYOUT order) the
 * next ids up to the farm's total. A farm's new turbines fill a staggered grid centred on the farm
 * (5 per row, every other row shifted half a column), skipping slots next to an original turbine,
 * coordinates rounded to 3 decimals like the fixture's. Every 10th id (ending in 7) is not
 * commissioned yet.
 */
export function demoFleetTurbines(): DemoTurbine[] {
  const fleet = [...ORIGINAL_TURBINES];
  let next = ORIGINAL_TURBINES.length + 1;
  for (const farm of DEMO_FARM_LAYOUT) {
    const originals = ORIGINAL_TURBINES.filter((o) => o.farmId === farm.farmId);
    const count = farm.turbines - originals.length;
    // Enough rows for the farm even if a few slots are skipped, centred on the farm.
    const rows = Math.ceil((count + originals.length) / GRID_COLUMNS) + 1;
    const slots: { latitude: number; longitude: number }[] = [];
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < GRID_COLUMNS; column++) {
        const latitude = round3(
          farm.latitude + (row - (rows - 1) / 2) * ROW_STEP_DEG,
        );
        const longitude = round3(
          farm.longitude +
            (column - (GRID_COLUMNS - 1) / 2 + (row % 2) / 2) * COLUMN_STEP_DEG,
        );
        const clear = originals.every(
          (o) =>
            Math.hypot(o.latitude - latitude, o.longitude - longitude) >=
            MIN_SPACING_DEG,
        );
        if (clear) slots.push({ latitude, longitude });
      }
    }
    for (const { latitude, longitude } of slots.slice(0, count)) {
      const n = next++;
      fleet.push(
        t(
          `TURB${String(n).padStart(3, '0')}`,
          farm.farmId,
          latitude,
          longitude,
          n % 10 !== 7,
        ),
      );
    }
  }
  return fleet;
}

export const DEMO_TURBINES: readonly DemoTurbine[] = demoFleetTurbines();

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

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}
