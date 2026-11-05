import { runLiveSummary, seedFromCsv } from '@nextera/shared';
import { SEED_DATA_DIR } from '@nextera/testing/seed-data';
import { FarmsCacheService } from '../src/farms-cache/farms-cache.service.js';
import { createTestApp, type TestApp } from './helpers.js';

const NOW = Date.now();

interface Item {
  id: string;
  farmId: string;
  farmName: string;
  commissioned: boolean;
  latest: {
    timestamp: string;
    powerOutputKw: number;
    alerts: unknown[];
  } | null;
}
interface Page {
  items: Item[];
  nextCursor: string | null;
  prevCursor: string | null;
  total: number;
  totalCapped: boolean;
}

/**
 * The million-turbine read routes over HTTP: the turbine list (filters, sorts, cursors, errors),
 * one turbine, the markers, the cached summaries (ETag, invalidation), the deprecated farm
 * overview's 413 and the report row cap. Their plans and ordering are tested in
 * packages/shared/test/fleet-queries.e2e-spec.ts; roles are in auth.e2e-spec.ts.
 */
describe('Fleet scale API (e2e)', () => {
  let t: TestApp;
  const get = (path: string, role: 'viewer' | 'owner' = 'viewer', h = {}) =>
    fetch(`${t.url}/api${path}`, { headers: { ...t.auth(role), ...h } });
  const page = async (query: string) =>
    (await (await get(`/turbines${query}`)).json()) as Page;
  const invalidate = () => t.app.get(FarmsCacheService).invalidate();

  const truncate = () =>
    t.prisma
      .$executeRaw`TRUNCATE TABLE turbine_latest, farm_live_summary, anomaly_episodes, telemetry_alerts, telemetry, turbines, farm_weather, farm_telemetry_rollups, farms`;

  beforeAll(async () => {
    t = await createTestApp();
    await truncate();
    await seedFromCsv(t.prisma, SEED_DATA_DIR); // 10 farms, TURB001 and TURB002
    // 30 more turbines on FARM01/FARM02; the first 24 report (XT007 and XT017 40 minutes ago)
    await t.prisma.$executeRaw`
      INSERT INTO turbines (turbine_id, farm_id, latitude, longitude, commissioned)
      SELECT 'XT' || lpad(g::text, 3, '0'), CASE WHEN g % 2 = 0 THEN 'FARM01' ELSE 'FARM02' END,
             41 + g / 100.0, -96, g % 3 <> 0
      FROM generate_series(1, 30) g`;
    await t.prisma.$executeRaw`
      INSERT INTO turbine_latest (turbine_id, farm_id, reading_id, "timestamp", received_at,
        power_output_kw, wind_speed_ms, rotor_rpm, blade_pitch_deg, gearbox_temp_c)
      SELECT turbine_id, farm_id, gen_random_uuid(),
             to_timestamp(${Math.floor(NOW / 1000)}) - CASE WHEN right(turbine_id, 1) = '7' THEN interval '40 minutes' ELSE interval '1 minute' END,
             now(), (substring(turbine_id from 3)::int * 37) % 11 * 100, 8, 12, 3, 70
      FROM turbines WHERE turbine_id LIKE 'XT%' AND substring(turbine_id from 3)::int <= 24`;
    await runLiveSummary(t.prisma);
    invalidate();
  });

  afterAll(async () => {
    await truncate();
    await t.app.close();
  });

  describe('GET /api/turbines', () => {
    it('returns the default page: 25 items with the farm name and latest reading, cursors and the exact total', async () => {
      const body = await page('');
      expect(body.items).toHaveLength(25);
      expect(body.total).toBe(32);
      expect(body.totalCapped).toBe(false);
      expect(body.prevCursor).toBeNull();
      expect(body.nextCursor).toEqual(expect.any(String));
      const ids = body.items.map((i) => i.id);
      expect(ids).toEqual([...ids].sort());
      const reporting = body.items.find((i) => i.id === 'XT002')!;
      expect(reporting).toMatchObject({
        farmId: 'FARM01',
        farmName: expect.any(String),
        latest: { alerts: [], powerOutputKw: expect.any(Number) },
      });
      // the CSV turbines have readings, from January: stale
      expect(body.items.find((i) => i.id === 'TURB001')!.latest).not.toBeNull();
    });

    it('pages forward and back through every turbine once, in both directions of a sort', async () => {
      for (const dir of ['asc', 'desc']) {
        const seen: string[] = [];
        let body = await page(`?sort=time&dir=${dir}&limit=10`);
        seen.push(...body.items.map((i) => i.id));
        while (body.nextCursor) {
          body = await page(
            `?sort=time&dir=${dir}&limit=10&cursor=${body.nextCursor}`,
          );
          seen.push(...body.items.map((i) => i.id));
        }
        expect(seen).toHaveLength(32);
        expect(new Set(seen).size).toBe(32);
        // the 6 without a reading are last, whatever the direction
        expect(seen.slice(-6).sort()).toEqual(
          [25, 26, 27, 28, 29, 30].map((n) => `XT0${n}`),
        );

        // and back by prevCursor
        const back: string[] = body.items.map((i) => i.id).reverse();
        let prev = body.prevCursor;
        while (prev) {
          const p = await page(`?sort=time&dir=${dir}&limit=10&cursor=${prev}`);
          back.push(...p.items.map((i) => i.id).reverse());
          prev = p.prevCursor;
        }
        expect(back.reverse()).toEqual(seen);
      }
    });

    it('filters by farm, commissioned, status, hasData and q, with the total of the filter', async () => {
      const farm = await page('?farmId=FARM01&limit=100');
      expect(farm.items.every((i) => i.farmId === 'FARM01')).toBe(true);
      expect(farm.total).toBe(farm.items.length);

      const uncommissioned = await page('?commissioned=false&limit=100');
      expect(uncommissioned.items.length).toBeGreaterThan(0);
      expect(uncommissioned.items.every((i) => !i.commissioned)).toBe(true);
      expect((await page('?commissioned=true&limit=100')).total).toBe(
        32 - uncommissioned.total,
      );

      const stale = await page('?status=stale&limit=100');
      expect(stale.items.map((i) => i.id)).toEqual([
        'TURB001',
        'TURB002',
        'XT007',
        'XT017',
      ]);
      const noData = await page('?status=no_data&limit=100');
      expect(noData.total).toBe(6);
      expect((await page('?hasData=true&limit=100')).total).toBe(26);
      expect((await page('?hasData=false&limit=100')).total).toBe(6);
      expect((await page('?status=reporting&limit=100')).total).toBe(22);

      const substring = await page('?q=xt00&limit=100'); // case-insensitive
      expect(substring.items.map((i) => i.id)).toEqual(
        Array.from({ length: 9 }, (_, i) => `XT00${i + 1}`),
      );
    });

    it('sorts by a reading value within a farm', async () => {
      const body = await page('?farmId=FARM01&sort=power&dir=desc&limit=100');
      const power = body.items
        .filter((i) => i.latest)
        .map((i) => i.latest!.powerOutputKw);
      expect(power).toEqual([...power].sort((a, b) => b - a));
      // turbines without a reading follow
      const firstNull = body.items.findIndex((i) => !i.latest);
      expect(body.items.slice(firstNull).every((i) => !i.latest)).toBe(true);
    });

    it('sends 400 for a metric sort without a farm, a bad or foreign cursor and bad parameters', async () => {
      for (const sort of ['power', 'wind', 'gearbox']) {
        const res = await get(`/turbines?sort=${sort}`);
        expect(res.status).toBe(400);
        expect(JSON.stringify(await res.json())).toContain('needs a farmId');
      }
      const bad = await get('/turbines?cursor=garbage');
      expect(bad.status).toBe(400);
      expect(JSON.stringify(await bad.json())).toContain('Invalid cursor');

      const timePage = await page('?sort=time&limit=5');
      const foreign = await get(
        `/turbines?sort=id&cursor=${timePage.nextCursor}`,
      );
      expect(foreign.status).toBe(400);
      expect(JSON.stringify(await foreign.json())).toContain('different sort');

      for (const query of [
        '?limit=0',
        '?limit=101',
        '?limit=x',
        '?sort=nope',
        '?dir=up',
        '?status=asleep',
        '?commissioned=maybe',
        '?hasData=1',
        '?bogus=1',
        `?q=${'x'.repeat(65)}`,
      ]) {
        expect((await get(`/turbines${query}`)).status, query).toBe(400);
      }
    });

    it('401 without a token', async () => {
      expect((await fetch(`${t.url}/api/turbines`)).status).toBe(401);
    });
  });

  describe('GET /api/turbines/:id', () => {
    it('returns the list item of a turbine', async () => {
      const res = await get('/turbines/XT002');
      expect(res.status).toBe(200);
      const item = (await res.json()) as Item;
      expect(item).toEqual((await page('?q=XT002')).items[0]);
    });

    it('returns latest null for a turbine without readings and 404 for an unknown one', async () => {
      expect(
        ((await (await get('/turbines/XT030')).json()) as Item).latest,
      ).toBeNull();
      const res = await get('/turbines/NOPE');
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).toContain(
        'Turbine NOPE not found',
      );
    });
  });

  describe('GET /api/farms/:farmId/turbine-markers', () => {
    it('lists a farm’s turbines with position and status', async () => {
      const res = await get('/farms/FARM01/turbine-markers');
      expect(res.status).toBe(200);
      const markers = (await res.json()) as {
        id: string;
        latitude: number;
        longitude: number;
        status: string;
        timestamp: string | null;
      }[];
      expect(markers.length).toBeGreaterThan(10);
      expect(
        markers.find((m) => m.id === 'XT007' || m.id === 'XT017'),
      ).toBeUndefined(); // odd ones are FARM02 or other
      expect(new Set(markers.map((m) => m.status))).toEqual(
        new Set(['reporting', 'stale', 'no_data']),
      );
      expect(markers[0]).toEqual({
        id: expect.any(String),
        latitude: expect.any(Number),
        longitude: expect.any(Number),
        status: expect.any(String),
        timestamp: expect.toSatisfy(
          (v: unknown) => v === null || typeof v === 'string',
        ),
      });
      expect(
        markers
          .filter((m) => m.status === 'no_data')
          .every((m) => m.timestamp === null),
      ).toBe(true);
    });

    it('404 for an unknown farm', async () => {
      const res = await get('/farms/NOPE/turbine-markers');
      expect(res.status).toBe(404);
      expect(JSON.stringify(await res.json())).toContain('Farm NOPE not found');
    });
  });

  describe('summaries (cached bytes with ETag)', () => {
    beforeEach(async () => {
      await runLiveSummary(t.prisma);
      invalidate();
    });

    it('GET /api/fleet/summary: the fleet totals', async () => {
      const res = await get('/fleet/summary');
      expect(res.status).toBe(200);
      expect(res.headers.get('cache-control')).toBe('private, no-cache');
      expect(res.headers.get('etag')).toMatch(/^W\/"/);
      expect(await res.json()).toEqual({
        farms: 10,
        turbines: 32,
        commissioned: expect.any(Number),
        reporting: 22,
        stale: 4,
        alerting: 0,
        powerOutputKw: expect.any(Number),
        asOf: expect.any(String),
      });
    });

    it('GET /api/farm-summaries: every farm with totals and no turbines', async () => {
      const res = await get('/farm-summaries');
      expect(res.status).toBe(200);
      const farms = (await res.json()) as Record<string, unknown>[];
      expect(farms).toHaveLength(10);
      expect(farms[0]).toEqual({
        id: 'FARM01',
        name: expect.any(String),
        latitude: expect.any(Number),
        longitude: expect.any(Number),
        turbineCount: expect.any(Number),
        commissioned: expect.any(Number),
        reporting: expect.any(Number),
        stale: expect.any(Number),
        alerting: 0,
        powerOutputKw: expect.any(Number),
        windSpeedMs: expect.toSatisfy(
          (v: unknown) => v === null || typeof v === 'number',
        ),
        asOf: expect.any(String),
      });
      expect(farms.reduce((n, f) => n + (f.turbineCount as number), 0)).toBe(
        32,
      );
      expect(farms[0]).not.toHaveProperty('turbines');
    });

    it.each(['/fleet/summary', '/farm-summaries'])(
      '%s answers a matching If-None-Match with 304 and no body',
      async (path) => {
        const first = await get(path);
        const etag = first.headers.get('etag')!;
        const second = await get(path, 'viewer', {
          'If-None-Match': etag,
          'Cache-Control': 'max-age=0',
        });
        expect(second.status).toBe(304);
        expect(await second.text()).toBe('');
      },
    );

    it('serves the cached bytes until a write invalidates them', async () => {
      const before = await (await get('/fleet/summary')).json();
      // a write that changes the summary's source, without the cache being told: still cached
      await t.prisma.turbine.update({
        where: { turbineId: 'TURB001' },
        data: { commissioned: true },
      });
      await runLiveSummary(t.prisma);
      expect(await (await get('/fleet/summary')).json()).toEqual(before);

      // PATCH through the API invalidates the cache (and changes its own turbine)
      const patch = await fetch(`${t.url}/api/turbines/TURB002`, {
        method: 'PATCH',
        headers: { ...t.auth('owner'), 'Content-Type': 'application/json' },
        body: JSON.stringify({ commissioned: true }),
      });
      expect(patch.status).toBe(200);
      await runLiveSummary(t.prisma);
      const after = (await (await get('/fleet/summary')).json()) as {
        commissioned: number;
      };
      expect(after.commissioned).toBe(
        (before as { commissioned: number }).commissioned + 2,
      );
    });
  });

  describe('GET /api/farms (deprecated)', () => {
    it('still returns the overview of a small fleet', async () => {
      const res = await get('/farms');
      expect(res.status).toBe(200);
      const farms = (await res.json()) as { turbines: unknown[] }[];
      expect(farms.reduce((n, f) => n + f.turbines.length, 0)).toBe(32);
    });

    it('answers 413 with a clear message above 5,000 turbines, before loading them', async () => {
      await t.prisma.$executeRaw`
        INSERT INTO turbines (turbine_id, farm_id, latitude, longitude)
        SELECT 'BIG' || lpad(g::text, 5, '0'), 'FARM03', 40, -95 FROM generate_series(1, 5000) g`;
      invalidate();
      try {
        const res = await get('/farms');
        expect(res.status).toBe(413);
        expect(JSON.stringify(await res.json())).toMatch(
          /more than 5000 turbines.*deprecated.*\/api\/farm-summaries/,
        );
      } finally {
        await t.prisma
          .$executeRaw`DELETE FROM turbines WHERE turbine_id LIKE 'BIG%'`;
        invalidate();
      }
      expect((await get('/farms')).status).toBe(200);
    });
  });

  describe('GET /api/reports/telemetry row cap', () => {
    const FARM = 'FARM04';
    const range = (from: string, to: string) =>
      `/reports/telemetry?farmId=${FARM}&from=${from}&to=${to}`;

    beforeAll(async () => {
      // 12 turbines x every 5 minutes for 31 days = 107,136 readings (> 100,000)
      await t.prisma.$executeRaw`
        INSERT INTO turbines (turbine_id, farm_id, latitude, longitude)
        SELECT 'RT' || lpad(g::text, 2, '0'), ${FARM}, 40, -95 FROM generate_series(1, 12) g`;
      await t.prisma.$executeRaw`
        INSERT INTO telemetry (turbine_id, farm_id, "timestamp", received_at,
          power_output_kw, wind_speed_ms, rotor_rpm, blade_pitch_deg, gearbox_temp_c)
        SELECT 'RT' || lpad(g::text, 2, '0'), ${FARM}, ts, ts, 1, 1, 1, 1, 1
        FROM generate_series(1, 12) g,
             generate_series(timestamptz '2026-01-01 00:00+00', timestamptz '2026-01-31 23:55+00', interval '5 minutes') ts`;
    }, 120_000);

    it('answers 400 with a clear message for a farm report over 100,000 readings, before loading rows', async () => {
      const res = await get(
        range('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z'),
        'owner',
      );
      expect(res.status).toBe(400);
      expect(JSON.stringify(await res.json())).toContain(
        'more than 100,000 readings: choose a shorter range or a single turbine',
      );
    });

    it('serves a narrower range, and the same range for one turbine', async () => {
      const day = await get(
        range('2026-01-10T00:00:00Z', '2026-01-11T00:00:00Z'),
        'owner',
      );
      expect(day.status).toBe(200);
      expect(
        ((await day.json()) as { readings: unknown[] }).readings,
      ).toHaveLength(12 * 288);
      const turbine = await get(
        '/reports/telemetry?turbineId=RT01&from=2026-01-01T00:00:00Z&to=2026-02-01T00:00:00Z',
        'owner',
      );
      expect(turbine.status).toBe(200);
      expect(
        ((await turbine.json()) as { readings: unknown[] }).readings,
      ).toHaveLength(31 * 288);
    });
  });
});
