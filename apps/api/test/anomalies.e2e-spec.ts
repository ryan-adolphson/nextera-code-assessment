import { listAnomalies, seedFromCsv } from '@nextera/shared';
import { SEED_DATA_DIR } from '@nextera/testing/seed-data';
import { createTestApp, type TestApp } from './helpers.js';

interface Episode {
  turbineId: string;
  farmId: string;
  kind: string;
  metric: string | null;
  start: string;
  end: string;
  readings: number;
  value: number | null;
  windSpeedMs: number | null;
  estimatedLostKwh: number | null;
}
interface Body {
  from: string;
  to: string;
  estimatedLostKwh: number;
  anomalies: Episode[];
}

const BASE = Date.parse('2026-02-01T00:00:00Z');
const at = (minutes: number) => new Date(BASE + minutes * 60_000);

/** GET /api/anomalies and the shared query on the CSV fixture, then on constructed fleets. */
describe('Anomalies API (e2e)', () => {
  let t: TestApp;
  const get = (query: string, role: 'viewer' | 'owner' = 'viewer') =>
    fetch(`${t.url}/api/anomalies${query}`, { headers: t.auth(role) });
  const range = (from: number, to: number) =>
    `?from=${at(from).toISOString()}&to=${at(to).toISOString()}`;

  /** A distinct value per call, so only the readings a test sets can repeat. */
  let seq = 0;
  const unique = () => 20 + (seq++ % 5000) / 100 + (seq % 7) / 1000;
  interface Spec {
    min: number;
    power?: number;
    wind?: number;
    rotor?: number;
    gearbox?: number;
  }
  const reading = (turbineId: string, s: Spec) => ({
    turbineId,
    farmId: 'FARM01',
    timestamp: at(s.min),
    receivedAt: at(s.min),
    powerOutputKw: s.power ?? 1500,
    windSpeedMs: s.wind ?? unique() / 10, // 2-7 m/s: never judged for low power
    rotorRpm: s.rotor ?? unique(),
    bladePitchDeg: 2,
    gearboxTempC: s.gearbox ?? unique(),
  });
  const insert = (turbineId: string, specs: Spec[]) =>
    t.prisma.telemetry.createMany({
      data: specs.map((s) => reading(turbineId, s)),
    });
  /** `count` readings every 5 minutes from minute `from`. */
  const run = (from: number, count: number, over: Omit<Spec, 'min'> = {}) =>
    Array.from({ length: count }, (_, i) => ({ min: from + i * 5, ...over }));
  /** Varied wind inside one 1 m/s bin, so wind itself is never "stuck". */
  const windIn = (bin: number, count: number, from: number, power: number) =>
    Array.from({ length: count }, (_, i) => ({
      min: from + i * 5,
      wind: bin + (i % 50) / 100,
      power,
    }));
  const reset = async () => {
    await t.prisma
      .$executeRaw`TRUNCATE TABLE telemetry_alerts, telemetry, turbines, farm_weather, farm_telemetry_rollups, farms`;
    await seedFromCsv(t.prisma, SEED_DATA_DIR);
    await t.prisma.$executeRaw`TRUNCATE TABLE telemetry_alerts, telemetry`;
    await t.prisma.turbine.createMany({
      data: ['BG', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I'].map((id) => ({
        turbineId: `X${id}`,
        farmId: 'FARM01',
        latitude: 41,
        longitude: -93,
      })),
    });
  };

  beforeAll(async () => {
    t = await createTestApp();
  });
  afterAll(async () => {
    await t.prisma
      .$executeRaw`TRUNCATE TABLE telemetry_alerts, telemetry, turbines, farm_weather, farm_telemetry_rollups, farms`;
    await t.app.close();
  });

  describe('the CSV fixture', () => {
    beforeAll(async () => {
      await t.prisma
        .$executeRaw`TRUNCATE TABLE telemetry_alerts, telemetry, turbines, farm_weather, farm_telemetry_rollups, farms`;
      await seedFromCsv(t.prisma, SEED_DATA_DIR);
    });

    it('finds the TURB001 stop (the short TURB002 gearbox fault is not a stuck sensor)', async () => {
      const res = await get(
        '?from=2026-01-01T00:00:00Z&to=2026-01-03T00:00:00Z',
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as Body;

      expect(body.anomalies).toContainEqual(
        expect.objectContaining({
          turbineId: 'TURB001',
          kind: 'low_power_in_wind',
          metric: null,
          start: '2026-01-01T13:40:00.000Z',
          end: '2026-01-01T13:50:00.000Z',
          readings: 3,
          value: null,
          windSpeedMs: 15.8,
        }),
      );
      // TURB002's 15-minute stuck gearbox (126.5 for 3 readings) is shorter than the 12 readings
      // a stuck sensor needs, so the fixture reports only the stop.
      expect(body.anomalies.map((a) => [a.turbineId, a.kind])).toEqual([
        ['TURB001', 'low_power_in_wind'],
      ]);
      const stop = body.anomalies.find((a) => a.kind === 'low_power_in_wind');
      expect(stop?.estimatedLostKwh).toBeGreaterThan(0);
      // The top-level total sums the non-null estimates.
      expect(body.estimatedLostKwh).toBeCloseTo(
        body.anomalies.reduce((s, a) => s + (a.estimatedLostKwh ?? 0), 0),
        1,
      );
      // Newest end first.
      const ends = body.anomalies.map((a) => a.end);
      expect(ends).toEqual([...ends].sort().reverse());
    });

    it('matches the shared query', async () => {
      const q = { from: '2026-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' };
      const direct = await listAnomalies(t.prisma, q);
      const res = await get(`?from=${q.from}&to=${q.to}`);
      expect(await res.json()).toEqual(direct);
    });
  });

  describe('range and access', () => {
    it.each([
      ['no params', ''],
      ['no to', '?from=2026-01-01T00:00:00Z'],
      ['a zone-less from', '?from=2026-01-01T00:00:00&to=2026-01-02T00:00:00Z'],
      ['a week date', '?from=2026-W01-4&to=2026-01-02T00:00:00Z'],
      [
        'an extra param',
        '?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z&x=1',
      ],
      [
        'to equal to from',
        '?from=2026-01-01T00:00:00Z&to=2026-01-01T00:00:00Z',
      ],
      ['to before from', '?from=2026-01-02T00:00:00Z&to=2026-01-01T00:00:00Z'],
      [
        'more than 31 days',
        '?from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:01Z',
      ],
    ])('400 for %s', async (_, query) => {
      expect((await get(query)).status).toBe(400);
    });

    it('accepts exactly 31 days and an empty window (200, nothing)', async () => {
      const res = await get(
        '?from=2025-01-01T00:00:00Z&to=2025-02-01T00:00:00Z',
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        from: '2025-01-01T00:00:00.000Z',
        to: '2025-02-01T00:00:00.000Z',
        estimatedLostKwh: 0,
        anomalies: [],
      });
    });

    it('401 without a token; a viewer is allowed', async () => {
      const q = '?from=2025-01-01T00:00:00Z&to=2025-01-02T00:00:00Z';
      expect((await fetch(`${t.url}/api/anomalies${q}`)).status).toBe(401);
      expect((await get(q, 'viewer')).status).toBe(200);
      expect((await get(q, 'owner')).status).toBe(200);
    });
  });

  describe('low_power_in_wind', () => {
    beforeAll(async () => {
      await reset();
      await insert('XBG', [
        ...windIn(9, 25, 0, 1500), // bin 9: median 1500
        ...windIn(12, 25, 200, 2000), // bin 12: median 2000
      ]);
      // XA: 2 low readings (not 3). XB: exactly 3 at wind 12.x. 3 x 2000 x 5/60 = 500.0
      await insert('XA', windIn(12, 2, 0, 0));
      await insert('XB', windIn(12, 3, 0, 0));
      // XC: a 10-minute gap splits 2 + 1. XD: a normal reading in between splits 2 + 1.
      await insert('XC', [...windIn(12, 2, 0, 0), ...windIn(12, 1, 20, 0)]);
      await insert('XD', [
        ...windIn(12, 2, 0, 0),
        ...windIn(12, 1, 10, 2000),
        ...windIn(12, 1, 15, 0),
      ]);
      // XE: wind 9.9 (below 10) never counts; XF: wind exactly 10.0 does. Bin 10 has only these
      // 3 readings, so it falls back to bin 9 (1500): 3 x 1500 x 5/60 = 375.0
      await insert(
        'XE',
        run(0, 3, { power: 0 }).map((s, i) => ({
          ...s,
          wind: 9.9 - i * 0.001,
        })),
      );
      await insert(
        'XF',
        run(0, 3, { power: 0 }).map((s, i) => ({ ...s, wind: 10 + i * 0.001 })),
      );
      // XG: power 10 % of expected is not below the limit (2000 -> 200): 200 passes, 199.9 fails.
      await insert('XG', windIn(12, 3, 0, 200));
      await insert('XH', windIn(12, 3, 0, 199.9));
    });

    it('needs 3 consecutive readings, with no gap and no normal reading between', async () => {
      const body = (await (await get(range(0, 400))).json()) as Body;
      const low = body.anomalies.filter((a) => a.kind === 'low_power_in_wind');
      expect(low.map((a) => a.turbineId).sort()).toEqual(['XB', 'XF', 'XH']);
    });

    it('uses the fleet median of the same 1 m/s bin, and the nearest bin below when it has < 20 readings', async () => {
      const body = (await (await get(range(0, 400))).json()) as Body;
      const byTurbine = (id: string) =>
        body.anomalies.find(
          (a) => a.turbineId === id && a.kind === 'low_power_in_wind',
        );
      expect(byTurbine('XB')).toMatchObject({
        readings: 3,
        value: null,
        metric: null,
        farmId: 'FARM01',
        start: at(0).toISOString(),
        end: at(10).toISOString(),
        estimatedLostKwh: 500,
      });
      expect(byTurbine('XB')?.windSpeedMs).toBeCloseTo(12.01, 2);
      // XF: wind 10.0 is judged (>= 10) against bin 9's median.
      expect(byTurbine('XF')?.estimatedLostKwh).toBe(375);
      // XH: 199.9 kW < 10 % of 2000; the loss is (2000 - 199.9) x 5/60 x 3 = 450.0 (rounded).
      expect(byTurbine('XH')?.estimatedLostKwh).toBe(450);
    });

    it('sums the non-null estimates into the total', async () => {
      const body = (await (await get(range(0, 400))).json()) as Body;
      expect(body.estimatedLostKwh).toBe(500 + 375 + 450);
    });
  });

  describe('low_power_in_wind without a populated bin', () => {
    beforeAll(async () => {
      await reset();
      // 3 readings: no bin has 20, so the ratio can't be judged and < 100 kW counts as low.
      await insert('XA', windIn(15, 3, 0, 50));
      await insert('XB', windIn(15, 3, 0, 150));
    });

    it('treats power < 100 kW as low, with no estimate', async () => {
      const body = (await (await get(range(0, 60))).json()) as Body;
      expect(body.anomalies).toEqual([
        expect.objectContaining({
          turbineId: 'XA',
          kind: 'low_power_in_wind',
          readings: 3,
          estimatedLostKwh: null,
        }),
      ]);
      expect(body.estimatedLostKwh).toBe(0);
    });
  });

  describe('stuck_sensor', () => {
    /** `count` readings every 5 minutes from `from`, power alternating by `swing` kW. */
    const moving = (
      from: number,
      count: number,
      swing: number,
      over: Omit<Spec, 'min' | 'power'> = {},
    ) =>
      run(from, count).map((s, i) => ({
        ...s,
        ...over,
        power: 1500 + (i % 2) * swing,
      }));

    beforeAll(async () => {
      await reset();
      // XA: 11 readings (1 short of the minimum). XB: exactly 12.
      await insert('XA', moving(0, 11, 100, { gearbox: 70 }));
      await insert('XB', moving(0, 12, 100, { gearbox: 70 }));
      // XC: power range 49.9 kW (below the minimum). XD: exactly 50 kW (at it, so it counts).
      await insert('XC', moving(0, 12, 49.9, { gearbox: 70 }));
      await insert('XD', moving(0, 12, 50, { gearbox: 70 }));
      // XE: a gap splits the run into 6 + 6 readings.
      await insert('XE', [
        ...moving(0, 6, 100, { gearbox: 70 }),
        ...moving(35, 6, 100, { gearbox: 70 }),
      ]);
      // XF: rotor and wind stuck for 12 readings, gearbox moving: two episodes.
      await insert('XF', moving(0, 12, 100, { rotor: 12.5, wind: 8.1 }));
      // XG: the stuck gearbox of the demo (126.5 for 18 readings, power moving).
      await insert('XG', moving(0, 18, 100, { gearbox: 126.5 }));
      // XH: a plateau, not a sensor fault: everything flat, power too (at 0 and at rated).
      await insert('XH', run(0, 12, { power: 0, gearbox: 70 }));
      await insert('XI', run(0, 12, { power: 3500, gearbox: 70 }));
    });

    it('needs 12 consecutive equal readings of gearbox, wind or rotor, with no gap, while power moves by >= 50 kW', async () => {
      const body = (await (await get(range(0, 400))).json()) as Body;
      const summary = body.anomalies
        .map((a) => [a.turbineId, a.metric, a.value, a.readings])
        .sort();
      expect(summary).toEqual([
        ['XB', 'gearboxTempC', 70, 12],
        ['XD', 'gearboxTempC', 70, 12],
        ['XF', 'rotorRpm', 12.5, 12],
        ['XF', 'windSpeedMs', 8.1, 12],
        ['XG', 'gearboxTempC', 126.5, 18],
      ]);
      for (const a of body.anomalies) {
        expect(a.kind).toBe('stuck_sensor');
        expect(a.windSpeedMs).toBeNull();
        expect(a.estimatedLostKwh).toBeNull();
      }
      expect(body.estimatedLostKwh).toBe(0);
    });

    it('lists the newest end first and takes [from, to) on measurement time', async () => {
      const all = (await (await get(range(0, 400))).json()) as Body;
      const ends = all.anomalies.map((a) => a.end);
      expect(ends).toEqual([...ends].sort().reverse());
      expect(all.anomalies[0]).toMatchObject({
        turbineId: 'XG', // 18 readings: ends at minute 85
        end: at(85).toISOString(),
        start: at(0).toISOString(),
      });

      // to is exclusive: cutting at minute 55 leaves 11 readings of every run; at 60, 12.
      const cut = (await (await get(range(0, 55))).json()) as Body;
      expect(cut.anomalies).toEqual([]);
      const edge = (await (await get(range(0, 60))).json()) as Body;
      expect(edge.anomalies.map((a) => a.turbineId)).toContain('XB');
      // from is inclusive: starting at minute 5 drops the first reading of every run.
      const late = (await (await get(range(5, 400))).json()) as Body;
      expect(late.anomalies.map((a) => a.turbineId)).toEqual(['XG']);
    });
  });
});
