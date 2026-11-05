import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient, Prisma } from '../src/generated/prisma/client.js';
import {
  TURBINE_TOTAL_CAP,
  alertsPage,
  fleetSummary,
  latestReadings,
  listFarmSummaries,
  listTurbines,
  turbineItem,
  turbineMarkers,
  type TurbineListItem,
  type TurbineListQuery,
  type TurbineSort,
} from '../src/wind/fleet-queries.js';
import { runLiveSummary } from '../src/wind/live-summary.js';
import { QueryInputError } from '../src/wind/query-support.js';
import { reportTelemetry } from '../src/wind/queries.js';
import {
  enabledAlertRules,
  insertTelemetryWithAlerts,
} from '../src/wind/store-telemetry.js';
import { openMigrationDb, type MigrationDb } from './migration-db.js';

const MIN = 60_000;
const NOW = new Date('2026-03-10T12:00:00Z');

/** Wraps a client so every `$queryRaw` statement is recorded (to EXPLAIN it afterwards). */
function recording(prisma: PrismaClient) {
  const queries: Prisma.Sql[] = [];
  const db = new Proxy(prisma, {
    get(target, prop) {
      if (prop === '$queryRaw') {
        return (strings: TemplateStringsArray, ...values: unknown[]) => {
          queries.push(Prisma.sql(strings, ...values));
          return target.$queryRaw(strings, ...values);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { db: db as PrismaClient, queries };
}

interface PlanNode {
  'Node Type': string;
  'Relation Name'?: string;
  'Index Name'?: string;
  'Index Cond'?: string;
  Plans?: PlanNode[];
}

/** Every relation and index a statement's plan touches, and its node types. */
async function explain(m: MigrationDb, sql: Prisma.Sql) {
  const result = await m.db.query(
    `EXPLAIN (FORMAT JSON) ${sql.text}`,
    sql.values as unknown[],
  );
  const root = result.rows[0]['QUERY PLAN'][0].Plan as PlanNode;
  const relations = new Set<string>();
  const indexes = new Set<string>();
  const nodes = new Set<string>();
  const seqScans = new Set<string>();
  const indexConds: string[] = [];
  const walk = (node: PlanNode) => {
    nodes.add(node['Node Type']);
    if (node['Node Type'] === 'Seq Scan' && node['Relation Name']) {
      seqScans.add(node['Relation Name']);
    }
    if (node['Index Cond']) indexConds.push(node['Index Cond']);
    if (node['Relation Name']) relations.add(node['Relation Name']);
    if (node['Index Name']) indexes.add(node['Index Name']);
    node.Plans?.forEach(walk);
  };
  walk(root);
  return { relations, indexes, nodes, seqScans, indexConds };
}

/** What each test fleet row looks like, to compute the expected order. */
interface Fixture {
  id: string;
  farmId: string;
  commissioned: boolean;
  /** Undefined = no turbine_latest row. */
  latest?: { at: number; power: number; wind: number; gearbox: number };
}

const FARMS = [
  { id: 'F1', name: 'Alpha Ridge' },
  { id: 'F2', name: 'Beta Hills' },
  { id: 'F3', name: 'Gamma Plains' },
];

/** 30 turbines: many ties in every sort key, 22 with a reading (two stale), 8 without. */
const FIXTURES: Fixture[] = Array.from({ length: 30 }, (_, i) => {
  const n = i + 1;
  return {
    id: `T${String(n).padStart(2, '0')}`,
    farmId: FARMS[i % 3].id,
    commissioned: n % 4 !== 0,
    latest:
      i < 22
        ? {
            // five distinct times (ties), every 7th is 40 minutes old: stale
            at: NOW.getTime() - (i % 7 === 6 ? 40 : (i % 5) * 2) * MIN,
            power: ((i * 37) % 11) * 100,
            wind: (i * 13) % 7,
            gearbox: 60 + ((i * 29) % 9),
          }
        : undefined,
  };
});

const keyOf = (
  f: Fixture,
  sort: TurbineSort,
): string | number | boolean | null => {
  switch (sort) {
    case 'id':
      return f.id;
    case 'farm':
      return f.farmId;
    case 'commissioned':
      return f.commissioned;
    case 'time':
      return f.latest?.at ?? null;
    case 'power':
      return f.latest?.power ?? null;
    case 'wind':
      return f.latest?.wind ?? null;
    case 'gearbox':
      return f.latest?.gearbox ?? null;
  }
};

/** The documented order: key (nulls last), then id, both flipped by `dir` (nulls stay last). */
function expectedOrder(
  rows: Fixture[],
  sort: TurbineSort,
  dir: 'asc' | 'desc',
): string[] {
  const sign = dir === 'asc' ? 1 : -1;
  const cmp = (a: string | number | boolean, b: string | number | boolean) =>
    a < b ? -1 : a > b ? 1 : 0;
  return [...rows]
    .sort((a, b) => {
      const ka = keyOf(a, sort);
      const kb = keyOf(b, sort);
      if (ka === null && kb !== null) return 1;
      if (kb === null && ka !== null) return -1;
      if (ka !== null && kb !== null && ka !== kb) return sign * cmp(ka, kb);
      return sign * cmp(a.id, b.id);
    })
    .map((f) => f.id);
}

describe('fleet queries (e2e)', () => {
  let m: MigrationDb;
  let prisma: PrismaClient;

  beforeAll(async () => {
    m = await openMigrationDb('99999999999999_fleet_reads');
    await m.migrateAll();
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: m.url }),
    });
    await prisma.farm.createMany({
      data: FARMS.map((f) => ({
        ...f,
        latitude: 41.5,
        longitude: -96.5,
      })),
    });
    await prisma.turbine.createMany({
      data: FIXTURES.map((f) => ({
        turbineId: f.id,
        farmId: f.farmId,
        latitude: 41 + Number(f.id.slice(1)) / 100,
        longitude: -96,
        commissioned: f.commissioned,
      })),
    });
    for (const f of FIXTURES.filter((x) => x.latest)) {
      const l = f.latest!;
      await m.db.query(
        `INSERT INTO turbine_latest (turbine_id, farm_id, reading_id, "timestamp", received_at,
           power_output_kw, wind_speed_ms, rotor_rpm, blade_pitch_deg, gearbox_temp_c)
         VALUES ($1, $2, gen_random_uuid(), $3, $3, $4, $5, 12, 3, $6)`,
        [f.id, f.farmId, new Date(l.at), l.power, l.wind, l.gearbox],
      );
    }
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await m?.close();
  });

  const list = (q: TurbineListQuery) =>
    listTurbines(prisma, { now: NOW, ...q });

  /** Walks every page forward by nextCursor; returns the pages' ids. */
  async function walkForward(q: TurbineListQuery) {
    const pages: TurbineListItem[][] = [];
    let page = await list(q);
    pages.push(page.items);
    expect(page.prevCursor).toBeNull(); // the first page has nothing before it
    for (let guard = 0; page.nextCursor && guard < 100; guard++) {
      page = await list({ ...q, cursor: page.nextCursor });
      pages.push(page.items);
    }
    expect(page.nextCursor).toBeNull();
    return { pages: pages.map((p) => p.map((i) => i.id)), last: page };
  }

  /** Walks back from the last page by prevCursor; returns the pages in reading order. */
  async function walkBackward(
    q: TurbineListQuery,
    last: { prevCursor: string | null; items: TurbineListItem[] },
  ) {
    const pages: string[][] = [last.items.map((i) => i.id)];
    let prev = last.prevCursor;
    for (let guard = 0; prev && guard < 100; guard++) {
      const page = await list({ ...q, cursor: prev });
      pages.unshift(page.items.map((i) => i.id));
      prev = page.prevCursor;
    }
    return pages;
  }

  describe('keyset paging', () => {
    const cases: { sort: TurbineSort; farmId?: string }[] = [
      { sort: 'id' },
      { sort: 'farm' },
      { sort: 'commissioned' },
      { sort: 'time' },
      { sort: 'power', farmId: 'F1' },
      { sort: 'wind', farmId: 'F2' },
      { sort: 'gearbox', farmId: 'F3' },
    ];

    it.each(
      cases.flatMap((c) =>
        (['asc', 'desc'] as const).map((dir) => ({ ...c, dir })),
      ),
    )(
      'sort=$sort dir=$dir farmId=$farmId: every turbine once, in order, forward and back (limit 4)',
      async ({ sort, dir, farmId }) => {
        const rows = FIXTURES.filter((f) => !farmId || f.farmId === farmId);
        const expected = expectedOrder(rows, sort, dir);
        const q: TurbineListQuery = { sort, dir, limit: 4, farmId };

        const { pages, last } = await walkForward(q);

        expect(pages.flat()).toEqual(expected);
        expect(pages.slice(0, -1).every((p) => p.length === 4)).toBe(true);
        // backwards from the last page: the same pages
        expect(await walkBackward(q, last)).toEqual(pages);
      },
    );

    it('puts turbines without a reading last in both directions, by id in the direction', async () => {
      for (const dir of ['asc', 'desc'] as const) {
        const all = (
          await walkForward({ sort: 'time', dir, limit: 100 })
        ).pages.flat();
        const noData = FIXTURES.filter((f) => !f.latest).map((f) => f.id);
        expect(all.slice(-noData.length)).toEqual(
          dir === 'asc' ? noData : [...noData].reverse(),
        );
      }
    });

    it('handles a page boundary exactly at the end of a segment (null keys follow)', async () => {
      // 22 turbines with a reading: pages of 22 end exactly where the 8 without begin
      const first = await list({ sort: 'time', limit: 22 });
      expect(first.items.every((i) => i.latest !== null)).toBe(true);
      expect(first.nextCursor).not.toBeNull();
      const second = await list({
        sort: 'time',
        limit: 22,
        cursor: first.nextCursor!,
      });
      expect(second.items.map((i) => i.latest)).toEqual(Array(8).fill(null));
      expect(second.nextCursor).toBeNull();
      // and back across the boundary
      const back = await list({
        sort: 'time',
        limit: 5,
        cursor: second.prevCursor!,
      });
      expect(back.items.map((i) => i.id)).toEqual(
        first.items.slice(-5).map((i) => i.id),
      );
    });

    it('a page larger than the data returns everything with no cursors', async () => {
      const page = await list({ limit: 100 });
      expect(page.items).toHaveLength(30);
      expect([page.nextCursor, page.prevCursor]).toEqual([null, null]);
    });

    it('returns an empty page and no cursors past the end', async () => {
      const lastId = expectedOrder(FIXTURES, 'id', 'asc').at(-1)!;
      const cursor = Buffer.from(
        JSON.stringify({ b: 'a', s: 'id', d: 'asc', k: null, i: lastId }),
      ).toString('base64url');
      const page = await list({ cursor });
      expect(page).toMatchObject({
        items: [],
        nextCursor: null,
        prevCursor: null,
      });
    });

    it('keeps its place when a turbine’s value changes between pages (a position, not a row)', async () => {
      const q: TurbineListQuery = { sort: 'power', farmId: 'F1', limit: 3 };
      const first = await list(q);
      const boundary = first.items.at(-1)!;
      // The boundary turbine's power jumps to the top of the order; the next page still starts
      // after the boundary POSITION and repeats nothing from the first page.
      await m.db.query(
        `UPDATE turbine_latest SET power_output_kw = 99999 WHERE turbine_id = $1`,
        [boundary.id],
      );
      try {
        const second = await list({ ...q, cursor: first.nextCursor! });
        const seen = new Set(first.items.map((i) => i.id));
        expect(second.items.length).toBeGreaterThan(0);
        // the moved row may come back later in the walk (documented), nothing else repeats
        expect(
          second.items.filter((i) => seen.has(i.id) && i.id !== boundary.id),
        ).toEqual([]);
        expect(second.items[0].latest!.powerOutputKw).toBeGreaterThanOrEqual(
          boundary.latest!.powerOutputKw,
        );
      } finally {
        await m.db.query(
          `UPDATE turbine_latest SET power_output_kw = $2 WHERE turbine_id = $1`,
          [boundary.id, boundary.latest!.powerOutputKw],
        );
      }
    });
  });

  describe('filters', () => {
    const ids = (q: TurbineListQuery) =>
      walkForward({ limit: 7, ...q }).then((r) => r.pages.flat());
    const expectIds = (rows: Fixture[]) => expectedOrder(rows, 'id', 'asc');

    it('farmId, commissioned, status and hasData, alone and together', async () => {
      const reporting = (f: Fixture) =>
        f.latest !== undefined && f.latest.at >= NOW.getTime() - 15 * MIN;
      const stale = (f: Fixture) =>
        f.latest !== undefined && f.latest.at < NOW.getTime() - 15 * MIN;

      expect(await ids({ farmId: 'F2' })).toEqual(
        expectIds(FIXTURES.filter((f) => f.farmId === 'F2')),
      );
      expect(await ids({ commissioned: false })).toEqual(
        expectIds(FIXTURES.filter((f) => !f.commissioned)),
      );
      expect(await ids({ status: 'reporting' })).toEqual(
        expectIds(FIXTURES.filter(reporting)),
      );
      expect(await ids({ status: 'stale' })).toEqual(
        expectIds(FIXTURES.filter(stale)),
      );
      expect(await ids({ status: 'no_data' })).toEqual(
        expectIds(FIXTURES.filter((f) => !f.latest)),
      );
      expect(await ids({ hasData: true })).toEqual(
        expectIds(FIXTURES.filter((f) => f.latest)),
      );
      expect(await ids({ hasData: false })).toEqual(
        expectIds(FIXTURES.filter((f) => !f.latest)),
      );
      expect(
        await ids({ farmId: 'F1', commissioned: true, status: 'reporting' }),
      ).toEqual(
        expectIds(
          FIXTURES.filter(
            (f) => f.farmId === 'F1' && f.commissioned && reporting(f),
          ),
        ),
      );
    });

    it.each(['time', 'power'] as const)(
      'filters combine with the %s sort (the rows without a reading follow only when allowed)',
      async (sort) => {
        const farmId = 'F1';
        const rows = FIXTURES.filter((f) => f.farmId === farmId);
        const base = { sort, farmId, limit: 3 } as const;

        const all = (await walkForward(base)).pages.flat();
        expect(all).toEqual(expectedOrder(rows, sort, 'asc'));
        const withData = (
          await walkForward({ ...base, hasData: true })
        ).pages.flat();
        expect(withData).toEqual(
          expectedOrder(
            rows.filter((f) => f.latest),
            sort,
            'asc',
          ),
        );
        const without = (
          await walkForward({ ...base, status: 'no_data' })
        ).pages.flat();
        expect(without).toEqual(
          expectedOrder(
            rows.filter((f) => !f.latest),
            sort,
            'asc',
          ),
        );
      },
    );

    it('contradicting filters give an empty page', async () => {
      expect(await list({ status: 'reporting', hasData: false })).toMatchObject(
        {
          items: [],
          total: 0,
          totalCapped: false,
        },
      );
    });

    it('q: a case-insensitive substring of the turbine id, or a farm id / name', async () => {
      expect(await ids({ q: 't1' })).toEqual(
        expectIds(FIXTURES.filter((f) => f.id.toLowerCase().includes('t1'))),
      );
      // '1' is in turbine ids and in the farm id F1: that farm's turbines match too
      expect(await ids({ q: '1' })).toEqual(
        expectIds(
          FIXTURES.filter((f) => f.id.includes('1') || f.farmId === 'F1'),
        ),
      );
      // an exact farm id, and a substring of a farm name, bring that farm's turbines
      expect(await ids({ q: 'f3' })).toEqual(
        expectIds(FIXTURES.filter((f) => f.farmId === 'F3')),
      );
      expect(await ids({ q: 'beta hil' })).toEqual(
        expectIds(FIXTURES.filter((f) => f.farmId === 'F2')),
      );
      expect(await ids({ q: 'nothing like it' })).toEqual([]);
    });

    it('q treats LIKE wildcards literally', async () => {
      expect(await ids({ q: '%' })).toEqual([]);
      expect(await ids({ q: 'T_1' })).toEqual([]);
    });

    it('reports the total: exact from the live summary when only farm / commissioned filter', async () => {
      await runLiveSummary(prisma, { now: NOW });
      const all = await list({ limit: 1 });
      expect(all).toMatchObject({ total: 30, totalCapped: false });
      expect(await list({ farmId: 'F1', limit: 1 })).toMatchObject({
        total: 10,
      });
      expect(await list({ commissioned: true, limit: 1 })).toMatchObject({
        total: FIXTURES.filter((f) => f.commissioned).length,
      });
      expect(
        await list({ commissioned: false, farmId: 'F2', limit: 1 }),
      ).toMatchObject({
        total: FIXTURES.filter((f) => f.farmId === 'F2' && !f.commissioned)
          .length,
      });
      // other filters are counted
      expect(await list({ status: 'stale', limit: 1 })).toMatchObject({
        total: FIXTURES.filter(
          (f) => f.latest && f.latest.at < NOW.getTime() - 15 * MIN,
        ).length,
      });
      expect(await list({ q: 'T0', limit: 1 })).toMatchObject({
        total: FIXTURES.filter((f) => f.id.includes('T0')).length,
      });
    });

    it('counts without a summary too (the first job run has not happened)', async () => {
      await prisma.$executeRaw`TRUNCATE TABLE farm_live_summary`;
      expect(await list({ limit: 1 })).toMatchObject({
        total: 30,
        totalCapped: false,
      });
      expect(await list({ farmId: 'F1', limit: 1 })).toMatchObject({
        total: 10,
      });
    });
  });

  describe('errors', () => {
    it.each([
      [{ sort: 'power' as const }, /needs a farmId/],
      [{ sort: 'wind' as const, q: 'T' }, /needs a farmId/],
      [{ sort: 'gearbox' as const, commissioned: true }, /needs a farmId/],
      [{ cursor: 'garbage' }, /Invalid cursor/],
      [{ limit: 101 }, /limit must be 1 to 100/],
    ])('%j → QueryInputError', async (q, message) => {
      const run = list(q);
      await expect(run).rejects.toBeInstanceOf(QueryInputError);
      await expect(run).rejects.toThrow(message);
    });

    it('a cursor of another sort is refused', async () => {
      const page = await list({ sort: 'time', limit: 3 });
      await expect(
        list({ sort: 'id', limit: 3, cursor: page.nextCursor! }),
      ).rejects.toThrow('The cursor belongs to a different sort');
      await expect(
        list({ sort: 'time', dir: 'desc', limit: 3, cursor: page.nextCursor! }),
      ).rejects.toThrow('The cursor belongs to a different sort');
    });
  });

  describe('items, a turbine and markers', () => {
    it('items carry the farm name, coordinates as numbers and the latest reading', async () => {
      const [first] = (await list({ limit: 1 })).items;
      expect(first).toEqual({
        id: 'T01',
        farmId: 'F1',
        farmName: 'Alpha Ridge',
        latitude: 41.01,
        longitude: -96,
        commissioned: true,
        latest: {
          id: expect.any(String),
          turbineId: 'T01',
          farmId: 'F1',
          timestamp: new Date(NOW.getTime()).toISOString(),
          receivedAt: new Date(NOW.getTime()).toISOString(),
          powerOutputKw: 0,
          windSpeedMs: 0,
          rotorRpm: 12,
          bladePitchDeg: 3,
          gearboxTempC: 60,
          alerts: [],
        },
      });
      const noData = (await list({ status: 'no_data', limit: 1 })).items[0];
      expect(noData.latest).toBeNull();
    });

    it('turbineItem is the same item; an unknown id is a QueryNotFoundError', async () => {
      const [first] = (await list({ limit: 1 })).items;
      expect(await turbineItem(prisma, 'T01')).toEqual(first);
      await expect(turbineItem(prisma, 'T99')).rejects.toThrow(
        'Turbine T99 not found',
      );
    });

    it('turbineMarkers: status from the latest reading, coordinates, 404 for an unknown farm', async () => {
      const markers = await turbineMarkers(prisma, 'F1', { now: NOW });
      expect(markers).toHaveLength(10);
      expect(markers[0]).toEqual({
        id: 'T01',
        latitude: 41.01,
        longitude: -96,
        status: 'reporting',
        timestamp: NOW.toISOString(),
      });
      const byStatus = new Set(markers.map((x) => x.status));
      expect(byStatus).toEqual(new Set(['reporting', 'stale', 'no_data']));
      expect(markers.find((x) => x.status === 'no_data')!.timestamp).toBeNull();
      await expect(turbineMarkers(prisma, 'F99')).rejects.toThrow(
        'Farm F99 not found',
      );
    });
  });

  describe('latest readings carry their alert rules', () => {
    it('loads the rules by (reading id, timestamp), worst level first', async () => {
      await prisma.alertConfig.createMany({
        data: [
          {
            measurementMetric: 'gearboxTempC',
            comparison: 'above',
            valueMetric: 100,
            alertLevel: 'warn',
          },
          {
            measurementMetric: 'gearboxTempC',
            comparison: 'above',
            valueMetric: 120,
            alertLevel: 'error',
          },
        ],
      });
      const at = new Date(NOW.getTime() + 5 * MIN);
      await prisma.$transaction(async (tx) =>
        insertTelemetryWithAlerts(
          tx,
          [
            {
              turbineId: 'T01',
              farmId: 'F1',
              timestamp: at,
              receivedAt: at,
              powerOutputKw: 1000,
              windSpeedMs: 8,
              rotorRpm: 12,
              bladePitchDeg: 3,
              gearboxTempC: 126.5,
            },
          ],
          await enabledAlertRules(tx),
        ),
      );

      const item = await turbineItem(prisma, 'T01');
      expect(item.latest!.gearboxTempC).toBe(126.5);
      expect(item.latest!.alerts.map((a) => a.alertLevel)).toEqual([
        'error',
        'warn',
      ]);
      const page = await list({ q: 't01', limit: 5 });
      expect(page.items[0].latest!.alerts).toHaveLength(2);
      const byId = await latestReadings(prisma, ['T01', 'T02', 'T99']);
      expect([...byId.keys()].sort()).toEqual(['T01', 'T02']);
    });
  });

  describe('alertsPage', () => {
    const at = (min: number) => new Date(NOW.getTime() + 60 * MIN + min * MIN);

    beforeAll(async () => {
      // 7 flagged readings over 3 turbines and 3 times (ties on time), one with two rules
      const rows = [
        ['T01', 0],
        ['T02', 0],
        ['T03', 0],
        ['T01', 5],
        ['T02', 5],
        ['T01', 10],
        ['T03', 10],
      ] as const;
      await prisma.$transaction(async (tx) =>
        insertTelemetryWithAlerts(
          tx,
          [
            ...rows.map(([turbineId, min]) => ({
              turbineId,
              farmId: FIXTURES.find((f) => f.id === turbineId)!.farmId,
              timestamp: at(min),
              receivedAt: at(min),
              powerOutputKw: 1000,
              windSpeedMs: 8,
              rotorRpm: 12,
              bladePitchDeg: 3,
              gearboxTempC: min === 5 ? 110 : 126.5, // 110: warn only; 126.5: warn + error
            })),
            // not flagged
            {
              turbineId: 'T04',
              farmId: FIXTURES.find((f) => f.id === 'T04')!.farmId,
              timestamp: at(0),
              receivedAt: at(0),
              powerOutputKw: 1,
              windSpeedMs: 8,
              rotorRpm: 12,
              bladePitchDeg: 3,
              gearboxTempC: 70,
            },
          ],
          await enabledAlertRules(tx),
        ),
      );
    });

    const range = {
      from: at(-1).toISOString(),
      to: at(11).toISOString(),
    };

    async function walk(limit: number) {
      const out: string[][] = [];
      let cursor: string | undefined;
      do {
        const page = await alertsPage(prisma, { ...range, limit, cursor });
        out.push(page.items.map((r) => `${r.timestamp}|${r.turbineId}`));
        cursor = page.nextCursor ?? undefined;
      } while (cursor);
      return out;
    }

    it('lists the flagged readings newest first, each once, whatever the page size', async () => {
      const all = (await walk(1000)).flat();
      expect(all).toHaveLength(7);
      const times = all.map((x) => x.split('|')[0]);
      expect(times).toEqual([...times].sort().reverse());
      for (const limit of [1, 2, 3, 6, 7]) {
        const pages = await walk(limit);
        expect(pages.flat().sort()).toEqual([...all].sort()); // none lost, none repeated
        expect(pages.slice(0, -1).every((p) => p.length === limit)).toBe(true);
      }
    });

    it('carries the rules on each reading, worst first, and omits unflagged readings', async () => {
      const page = await alertsPage(prisma, { ...range, limit: 1000 });
      expect(page.nextCursor).toBeNull();
      expect(page.items.some((r) => r.turbineId === 'T04')).toBe(false);
      const hot = page.items.find((r) => r.gearboxTempC === 126.5)!;
      expect(hot.alerts.map((a) => a.alertLevel)).toEqual(['error', 'warn']);
      const warm = page.items.find((r) => r.gearboxTempC === 110)!;
      expect(warm.alerts.map((a) => a.alertLevel)).toEqual(['warn']);
    });

    it('respects [from, to) and gives an empty page without a cursor outside it', async () => {
      const exact = await alertsPage(prisma, {
        from: at(5).toISOString(),
        to: at(10).toISOString(),
      });
      expect(exact.items.map((r) => r.timestamp)).toEqual([
        at(5).toISOString(),
        at(5).toISOString(),
      ]);
      expect(
        await alertsPage(prisma, {
          from: at(100).toISOString(),
          to: at(110).toISOString(),
        }),
      ).toEqual({ items: [], nextCursor: null });
    });
  });

  describe('summaries', () => {
    it('farm summaries and the fleet summary compute missing farms, then match the stored job output', async () => {
      await prisma.$executeRaw`TRUNCATE TABLE farm_live_summary`;
      const computed = await listFarmSummaries(prisma, { now: NOW });
      const computedFleet = await fleetSummary(prisma, { now: NOW });

      await runLiveSummary(prisma, { now: NOW });
      const stored = await listFarmSummaries(prisma, { now: NOW });
      const storedFleet = await fleetSummary(prisma, { now: NOW });

      expect(computed).toEqual(stored);
      expect(computedFleet).toEqual(storedFleet);
      expect(stored.map((f) => f.id)).toEqual(['F1', 'F2', 'F3']);
      expect(stored[0]).toMatchObject({
        id: 'F1',
        name: 'Alpha Ridge',
        latitude: 41.5,
        turbineCount: 10,
        asOf: NOW.toISOString(),
      });
      expect(storedFleet).toMatchObject({
        farms: 3,
        turbines: 30,
        commissioned: FIXTURES.filter((f) => f.commissioned).length,
        asOf: NOW.toISOString(),
      });
      expect(storedFleet.reporting + storedFleet.stale).toBe(22);
      expect(stored.reduce((sum, f) => sum + f.reporting, 0)).toBe(
        storedFleet.reporting,
      );
    });

    it('an empty fleet has zero totals and a null asOf', async () => {
      const empty = await openMigrationDb('99999999999999_fleet_empty');
      await empty.migrateAll();
      const p = new PrismaClient({
        adapter: new PrismaPg({ connectionString: empty.url }),
      });
      try {
        expect(await fleetSummary(p)).toEqual({
          farms: 0,
          turbines: 0,
          commissioned: 0,
          reporting: 0,
          stale: 0,
          alerting: 0,
          powerOutputKw: 0,
          asOf: null,
        });
        expect(await listFarmSummaries(p)).toEqual([]);
        expect(await list_({ p })).toMatchObject({ items: [], total: 0 });
      } finally {
        await p.$disconnect();
        await empty.close();
      }
    });
  });
});

const list_ = ({ p }: { p: PrismaClient }) => listTurbines(p, {});

/**
 * Query plans on a fleet big enough for the planner to choose indexes (150,000 turbines): the
 * list's queries must use their indexes at every depth, and the time-range reads must prune
 * partitions. (The same checks were run by hand at 1,000,000 turbines.)
 */
describe('fleet query plans (e2e)', () => {
  const BULK = 150_000;
  let m: MigrationDb;
  let prisma: PrismaClient;

  beforeAll(async () => {
    m = await openMigrationDb('99999999999999_fleet_plans');
    await m.migrateAll();
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: m.url }),
    });
    await m.db.query(`
      INSERT INTO farms (id, name, latitude, longitude)
      SELECT 'PF' || lpad(g::text, 4, '0'), 'Plan Farm ' || g, 40, -95 FROM generate_series(1, 150) g;
      INSERT INTO turbines (turbine_id, farm_id, latitude, longitude, commissioned)
      SELECT 'PT' || lpad(g::text, 7, '0'), 'PF' || lpad((g % 150 + 1)::text, 4, '0'), 40, -95, g % 7 <> 0
      FROM generate_series(1, ${BULK}) g;
      INSERT INTO turbine_latest (turbine_id, farm_id, reading_id, "timestamp", received_at,
        power_output_kw, wind_speed_ms, rotor_rpm, blade_pitch_deg, gearbox_temp_c, worst_alert_level)
      SELECT turbine_id, farm_id, gen_random_uuid(),
        timestamp '2026-03-10 12:00+00' - ((hashtext(turbine_id) & 7) * interval '5 minutes')
          - (CASE WHEN hashtext(turbine_id) % 10 = 0 THEN interval '1 hour' ELSE interval '0' END),
        timestamp '2026-03-10 12:00+00', (hashtext(turbine_id) & 2047), 8, 12, 3, 70, NULL
      FROM turbines WHERE hashtext(turbine_id) % 25 <> 0;
      ANALYZE;`);
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await m?.close();
  });

  /** Runs listTurbines, then EXPLAINs every row-reading statement it issued. */
  async function plansOf(q: TurbineListQuery) {
    const { db, queries } = recording(prisma);
    const result = await listTurbines(db, { now: NOW, ...q });
    const plans = [];
    for (const sql of queries) {
      // the page's statements; the alerts / farm lookups are by key and always indexed
      if (/ORDER BY/.test(sql.text) && /FROM turbine/.test(sql.text)) {
        plans.push(await explain(m, sql));
      }
    }
    return { result, plans };
  }
  const deepCursor = (sort: 'id', id: string) =>
    Buffer.from(
      JSON.stringify({ b: 'a', s: sort, d: 'asc', k: null, i: id }),
    ).toString('base64url');

  it('first page: an index scan in id order, no sequential scan of turbines', async () => {
    const { result, plans } = await plansOf({});
    expect(result.items).toHaveLength(25);
    for (const p of plans) {
      expect(p.indexes).toContain('turbines_turbine_id_key');
      expect(p.relations).not.toContain('turbine_latest_no_such');
      expect([...p.seqScans].filter((r) => r !== 'farms')).toEqual([]);
    }
  });

  it('a deep cursor still reads by index, from the cursor on (the latest side is bounded too)', async () => {
    const { result, plans } = await plansOf({
      cursor: deepCursor('id', 'PT0140000'),
    });
    expect(result.items[0].id).toBe('PT0140001');
    for (const p of plans) {
      expect(p.indexes).toContain('turbines_turbine_id_key');
      expect([...p.seqScans].filter((r) => r !== 'farms')).toEqual([]);
      // turbine_latest is bounded by the cursor too: an unbounded merge join read it from the start
      expect(
        p.indexConds.filter((c) => c.includes('PT0140000')).length,
      ).toBeGreaterThanOrEqual(2);
    }
  });

  it('a farm filter and the farm sort use the (farm_id, turbine_id) index', async () => {
    for (const q of [{ farmId: 'PF0042' }, { sort: 'farm' as const }]) {
      const { plans } = await plansOf(q);
      for (const p of plans) {
        expect(p.indexes).toContain('turbines_farm_id_turbine_id_idx');
        expect([...p.seqScans].filter((r) => r !== 'farms')).toEqual([]);
      }
    }
  });

  it('the commissioned filter and sort use the (commissioned, turbine_id) index', async () => {
    for (const q of [
      { commissioned: false },
      { sort: 'commissioned' as const, dir: 'desc' as const },
    ]) {
      const { plans } = await plansOf(q);
      for (const p of plans) {
        expect(p.indexes).toContain('turbines_commissioned_turbine_id_idx');
        expect([...p.seqScans].filter((r) => r !== 'farms')).toEqual([]);
      }
    }
  });

  it('a substring search uses the trigram index', async () => {
    const { result, plans } = await plansOf({ q: '0123456' });
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items.every((i) => i.id.includes('0123456'))).toBe(true);
    expect(
      plans.some((p) => p.indexes.has('turbines_turbine_id_trgm_idx')),
    ).toBe(true);
  });

  it('the last-seen sort reads turbine_latest by its (timestamp, turbine_id) index, ties included', async () => {
    const first = await plansOf({ sort: 'time', dir: 'desc' });
    for (const p of first.plans.slice(0, 1)) {
      expect(p.indexes).toContain('turbine_latest_timestamp_turbine_id_idx');
      expect([...p.seqScans].filter((r) => r !== 'farms')).toEqual([]);
    }
    const next = await plansOf({
      sort: 'time',
      dir: 'desc',
      cursor: first.result.nextCursor!,
    });
    expect(next.plans[0].indexes).toContain(
      'turbine_latest_timestamp_turbine_id_idx',
    );
    expect([...next.plans[0].seqScans].filter((r) => r !== 'farms')).toEqual(
      [],
    );
  });

  it('totals are capped at 10,000 and flagged', async () => {
    const page = await listTurbines(prisma, { now: NOW, q: 'PT', limit: 5 });
    expect(page).toMatchObject({ total: TURBINE_TOTAL_CAP, totalCapped: true });
    const exact = await listTurbines(prisma, {
      now: NOW,
      q: 'PF0042',
      limit: 5,
    });
    expect(exact).toMatchObject({ total: BULK / 150, totalCapped: false });
  });

  it('the unfiltered total comes from the summaries, not a count', async () => {
    await runLiveSummary(prisma, { now: NOW });
    const { db, queries } = recording(prisma);
    const page = await listTurbines(db, { now: NOW, limit: 5 });
    expect(page).toMatchObject({ total: BULK, totalCapped: false });
    expect(queries.some((q) => /count\(\*\)::int AS n/.test(q.text))).toBe(
      false,
    );
  });

  describe('time ranges prune partitions', () => {
    const days = [
      '2026-03-08',
      '2026-03-09',
      '2026-03-10',
      '2026-03-11',
      '2026-03-12',
    ];

    beforeAll(async () => {
      for (const day of days) {
        await m.db.query(`SELECT telemetry_ensure_partition($1::date)`, [day]);
      }
      await prisma.alertConfig.create({
        data: {
          measurementMetric: 'gearboxTempC',
          comparison: 'above',
          valueMetric: 100,
          alertLevel: 'warn',
        },
      });
      await prisma.$transaction(async (tx) =>
        insertTelemetryWithAlerts(
          tx,
          days.map((day) => ({
            turbineId: 'PT0000001',
            farmId: 'PF0002',
            timestamp: new Date(`${day}T10:00:00Z`),
            receivedAt: new Date(`${day}T10:00:00Z`),
            powerOutputKw: 1,
            windSpeedMs: 8,
            rotorRpm: 12,
            bladePitchDeg: 3,
            gearboxTempC: 126.5,
          })),
          await enabledAlertRules(tx),
        ),
      );
      await m.db.query('ANALYZE');
    });

    const partitionsOf = (relations: Set<string>) =>
      [...relations]
        .filter((r) => /_p\d{8}$/.test(r))
        .map((r) => r.slice(-8))
        .sort();

    it('the alert history reads only the partitions of its range', async () => {
      const { db, queries } = recording(prisma);
      const page = await alertsPage(db, {
        from: '2026-03-09T00:00:00Z',
        to: '2026-03-11T00:00:00Z',
      });
      expect(page.items.map((r) => r.timestamp.slice(0, 10)).sort()).toEqual([
        '2026-03-09',
        '2026-03-10',
      ]);
      const keysPlan = await explain(m, queries[0]);
      expect(partitionsOf(keysPlan.relations)).toEqual([
        '20260309',
        '20260310',
      ]);
    });

    it('a report’s row count reads only the partitions of its range', async () => {
      const { db, queries } = recording(prisma);
      await reportTelemetry(db, {
        turbineId: 'PT0000001',
        from: '2026-03-10T00:00:00Z',
        to: '2026-03-11T00:00:00Z',
      });
      const count = queries.find((q) =>
        /SELECT count\(\*\)::int AS n/.test(q.text),
      )!;
      const plan = await explain(m, count);
      expect(partitionsOf(plan.relations)).toEqual(['20260310']);
    });
  });
});
