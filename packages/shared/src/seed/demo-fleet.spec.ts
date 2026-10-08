import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { DEMO_ALERT_RULES, DEMO_TURBINES } from './demo-fleet.js';
import { parseCsv } from './seed-from-csv.js';

const DATA_DIR = fileURLToPath(new URL('../../prisma/data', import.meta.url));
const csv = (file: string, columns: string[]) =>
  parseCsv(readFileSync(`${DATA_DIR}/${file}`, 'utf8'), columns);

describe('DEMO_TURBINES', () => {
  it('has unique ids and 2–3 turbines on every fixture farm', () => {
    const farms = csv('farms.csv', [
      'farm_id',
      'farm_name',
      'latitude',
      'longitude',
    ]);
    const ids = DEMO_TURBINES.map((t) => t.turbineId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(25);
    for (const farm of farms) {
      const count = DEMO_TURBINES.filter(
        (t) => t.farmId === farm.farm_id,
      ).length;
      expect(count, farm.farm_id).toBeGreaterThanOrEqual(2);
      expect(count, farm.farm_id).toBeLessThanOrEqual(3);
    }
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
