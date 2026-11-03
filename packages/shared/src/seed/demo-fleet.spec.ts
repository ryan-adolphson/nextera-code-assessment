import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DEMO_ALERT_RULES,
  DEMO_FARM_LAYOUT,
  DEMO_TURBINES,
  demoFleetTurbines,
} from './demo-fleet.js';
import { parseCsv } from './seed-from-csv.js';

const DATA_DIR = fileURLToPath(new URL('../../prisma/data', import.meta.url));
const csv = (file: string, columns: string[]) =>
  parseCsv(readFileSync(`${DATA_DIR}/${file}`, 'utf8'), columns);

const farms = csv('farms.csv', [
  'farm_id',
  'farm_name',
  'latitude',
  'longitude',
]);
const id = (n: number) => `TURB${String(n).padStart(3, '0')}`;
/** Distance in km (equirectangular: fine at a few km). */
const km = (
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number },
) =>
  111.2 *
  Math.hypot(
    a.latitude - b.latitude,
    (a.longitude - b.longitude) * Math.cos((a.latitude * Math.PI) / 180),
  );

describe('DEMO_TURBINES', () => {
  it('is TURB001–TURB200, unique, deterministic', () => {
    const ids = DEMO_TURBINES.map((t) => t.turbineId);
    expect(ids).toHaveLength(200);
    expect(new Set(ids).size).toBe(200);
    expect([...ids].sort()).toEqual(
      Array.from({ length: 200 }, (_, i) => id(i + 1)),
    );
    expect(demoFleetTurbines()).toEqual(DEMO_TURBINES);
  });

  it('spreads 16–24 turbines over every fixture farm, as DEMO_FARM_LAYOUT says', () => {
    expect(DEMO_FARM_LAYOUT.map((f) => f.farmId)).toEqual(
      farms.map((f) => f.farm_id),
    );
    expect(DEMO_FARM_LAYOUT.reduce((n, f) => n + f.turbines, 0)).toBe(200);
    for (const farm of DEMO_FARM_LAYOUT) {
      const fixture = farms.find((f) => f.farm_id === farm.farmId)!;
      // The layout's centre is the fixture farm's.
      expect([farm.latitude, farm.longitude], farm.farmId).toEqual([
        Number(fixture.latitude),
        Number(fixture.longitude),
      ]);
      const count = DEMO_TURBINES.filter(
        (t) => t.farmId === farm.farmId,
      ).length;
      expect(count, farm.farmId).toBe(farm.turbines);
      expect(count, farm.farmId).toBeGreaterThanOrEqual(16);
      expect(count, farm.farmId).toBeLessThanOrEqual(24);
    }
  });

  it('keeps TURB001–TURB025 exactly as they were (farm, coordinates, commissioned)', () => {
    // The original demo fleet, before it grew to 200: local data and moves stay coherent.
    const original = [
      ['TURB001', 'FARM01', 41.263, -96.518, false],
      ['TURB003', 'FARM01', 41.241, -96.544, true],
      ['TURB004', 'FARM01', 41.257, -96.551, true],
      ['TURB002', 'FARM02', 39.741, -101.207, false],
      ['TURB005', 'FARM02', 39.762, -101.229, true],
      ['TURB006', 'FARM02', 39.738, -101.241, true],
      ['TURB007', 'FARM03', 35.131, -106.538, true],
      ['TURB008', 'FARM03', 35.108, -106.567, true],
      ['TURB009', 'FARM04', 44.991, -103.428, true],
      ['TURB010', 'FARM04', 44.972, -103.452, true],
      ['TURB011', 'FARM04', 44.985, -103.461, true],
      ['TURB012', 'FARM05', 31.893, -102.158, false],
      ['TURB013', 'FARM05', 31.869, -102.183, true],
      ['TURB014', 'FARM06', 42.124, -93.607, true],
      ['TURB015', 'FARM06', 42.101, -93.631, true],
      ['TURB016', 'FARM06', 42.118, -93.638, true],
      ['TURB017', 'FARM07', 34.733, -111.818, true],
      ['TURB018', 'FARM07', 34.709, -111.844, true],
      ['TURB019', 'FARM08', 46.231, -112.427, true],
      ['TURB020', 'FARM08', 46.208, -112.455, true],
      ['TURB021', 'FARM09', 38.923, -98.104, true],
      ['TURB022', 'FARM09', 38.897, -98.131, true],
      ['TURB023', 'FARM09', 38.915, -98.139, true],
      ['TURB024', 'FARM10', 36.563, -121.906, true],
      ['TURB025', 'FARM10', 36.538, -121.934, false],
    ].map(([turbineId, farmId, latitude, longitude, commissioned]) => ({
      turbineId,
      farmId,
      latitude,
      longitude,
      commissioned,
    }));
    expect(DEMO_TURBINES.slice(0, 25)).toEqual(original);
  });

  it('gives each farm a contiguous block of the new ids', () => {
    let next = 26;
    for (const farm of DEMO_FARM_LAYOUT) {
      const added = DEMO_TURBINES.slice(25)
        .filter((t) => t.farmId === farm.farmId)
        .map((t) => t.turbineId);
      expect(added, farm.farmId).toEqual(
        Array.from({ length: added.length }, (_, i) => id(next + i)),
      );
      next += added.length;
    }
    expect(next).toBe(201);
  });

  it('places the turbines within 3 km of their farm centre, at least 300 m apart, on a 3-decimal grid', () => {
    for (const farm of DEMO_FARM_LAYOUT) {
      const turbines = DEMO_TURBINES.filter((t) => t.farmId === farm.farmId);
      for (const t of turbines) {
        expect(km(t, farm), t.turbineId).toBeLessThan(3);
        expect(Math.round(t.latitude * 1000) / 1000).toBe(t.latitude);
        expect(Math.round(t.longitude * 1000) / 1000).toBe(t.longitude);
        for (const other of turbines) {
          if (other !== t) {
            expect(
              km(t, other),
              `${t.turbineId}–${other.turbineId}`,
            ).toBeGreaterThan(0.3);
          }
        }
      }
    }
  });

  it('leaves about 1 in 10 of the new turbines uncommissioned', () => {
    const added = DEMO_TURBINES.slice(25);
    const off = added.filter((t) => !t.commissioned).length;
    expect(off).toBeGreaterThanOrEqual(15);
    expect(off).toBeLessThanOrEqual(20);
  });

  it('keeps the fixture turbines exactly as in turbines.csv', () => {
    const fixture = csv('turbines.csv', [
      'turbine_id',
      'farm_id',
      'farm_name',
      'latitude',
      'longitude',
    ]);
    for (const t of fixture) {
      expect(DEMO_TURBINES).toContainEqual(
        expect.objectContaining({
          turbineId: t.turbine_id,
          farmId: t.farm_id,
          latitude: Number(t.latitude),
          longitude: Number(t.longitude),
        }),
      );
    }
  });
});

describe('DEMO_ALERT_RULES', () => {
  it('has one rule per metric, comparison and level (the unique index)', () => {
    const keys = DEMO_ALERT_RULES.map(
      (r) => `${r.measurementMetric}:${r.comparison}:${r.alertLevel}`,
    );
    expect(new Set(keys).size).toBe(keys.length);
  });
});
