import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import type {
  PrismaClient,
  UnallocatedTurbine,
} from '../generated/prisma/client.js';
import {
  HELD_RETENTION_MS,
  blockUnallocated,
  classifyReadings,
  holdReadings,
  type HeldEntry,
  type HoldableReading,
} from '../wind/unallocated.js';
import { DEMO_TURBINES } from './demo-fleet.js';
import {
  DEMO_UNALLOCATED,
  demoUnallocatedReadings,
  seedDemoUnallocated,
} from './demo-unallocated.js';
import { DEMO_ANOMALIES } from './generate-telemetry.js';
import { SEED_USERS } from './seed-users.js';

// The hold/block logic is tested in unallocated.spec.ts and unallocated.e2e-spec.ts; here only how
// the seed drives it.
vi.mock(import('../wind/unallocated.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  blockUnallocated: vi.fn(() => Promise.resolve()),
  classifyReadings: vi.fn(),
  holdReadings: vi.fn(),
}));

const END = new Date('2026-10-08T12:02:00Z'); // floored to 12:00
const END_MS = Date.parse('2026-10-08T12:00:00Z');
const MIN = 60_000;
const demoFarm = new Map(DEMO_TURBINES.map((t) => [t.turbineId, t.farmId]));
const FARMS = new Set(DEMO_TURBINES.map((t) => t.farmId));

describe('DEMO_UNALLOCATED', () => {
  it('has one entry per pair', () => {
    const pairs = DEMO_UNALLOCATED.map(
      (e) => `${e.turbineId}@${e.reportedFarmId}`,
    );
    expect(new Set(pairs).size).toBe(pairs.length);
  });

  it('covers every kind × status the Unallocated tab shows, without clashing with the demo fleet', () => {
    const describe = DEMO_UNALLOCATED.map((e) => {
      const farm = demoFarm.get(e.turbineId);
      // A demo turbine is never planned on its own farm (it would be telemetry, not unallocated).
      expect(farm, e.turbineId).not.toBe(e.reportedFarmId);
      return [
        e.turbineId,
        farm ? 'farm_mismatch' : 'unknown_turbine',
        FARMS.has(e.reportedFarmId) ? 'farm exists' : 'unknown farm',
        e.status,
      ];
    });
    expect(describe).toEqual([
      ['TURB099', 'unknown_turbine', 'farm exists', 'pending'],
      ['TURB098', 'unknown_turbine', 'unknown farm', 'pending'],
      ['TURB003', 'farm_mismatch', 'farm exists', 'pending'],
      ['TURB004', 'farm_mismatch', 'unknown farm', 'pending'],
      ['TURB097', 'unknown_turbine', 'farm exists', 'blocked'],
      ['TURB005', 'farm_mismatch', 'farm exists', 'blocked'],
    ]);
  });

  it('continues the pair the live demo feed publishes', () => {
    expect(DEMO_UNALLOCATED[0]).toMatchObject({
      turbineId: DEMO_ANOMALIES.unallocated.turbineId,
      reportedFarmId: DEMO_ANOMALIES.unallocated.farmId,
      status: 'pending',
      endOffsetMinutes: 0,
    });
  });

  it('blocks only blocked entries, after their readings, by seed users', () => {
    const emails = new Set(SEED_USERS.map((u) => u.email));
    for (const e of DEMO_UNALLOCATED) {
      if (e.status === 'blocked') {
        expect(e.blocked, e.turbineId).toBeDefined();
        expect(emails.has(e.blocked!.byEmail)).toBe(true);
        expect(e.blocked!.offsetMinutes).toBeLessThan(e.endOffsetMinutes);
      } else {
        expect(e.blocked, e.turbineId).toBeUndefined();
      }
    }
  });
});

describe('demoUnallocatedReadings', () => {
  it('generates 5-minute readings as reported, ending at the entry offset before the floored end', () => {
    for (const e of DEMO_UNALLOCATED) {
      const rows = demoUnallocatedReadings(e, END);
      expect(rows).toHaveLength(e.hours * 12);
      expect(
        rows.every(
          (r) =>
            r.turbineId === e.turbineId &&
            r.farmId === e.reportedFarmId &&
            r.timestamp.getTime() % (5 * MIN) === 0 &&
            r.receivedAt > r.timestamp,
        ),
      ).toBe(true);
      expect(rows.at(-1)!.timestamp.getTime()).toBe(
        END_MS - e.endOffsetMinutes * MIN,
      );
      const span =
        rows.at(-1)!.timestamp.getTime() - rows[0].timestamp.getTime();
      expect(span).toBe((e.hours * 12 - 1) * 5 * MIN);
      // Within the held readings' retention.
      expect(span).toBeLessThan(HELD_RETENTION_MS);
    }
  });

  it('is deterministic and continues across ends (same values at the same time)', () => {
    const [turb099] = DEMO_UNALLOCATED;
    const a = demoUnallocatedReadings(turb099, END);
    expect(demoUnallocatedReadings(turb099, END)).toEqual(a);
    const later = demoUnallocatedReadings(turb099, new Date(END_MS + 60 * MIN));
    const at = (rows: typeof a, ms: number) =>
      rows.find((r) => r.timestamp.getTime() === ms);
    expect(at(later, END_MS)).toEqual(at(a, END_MS));
  });
});

describe('seedDemoUnallocated', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  /** Entries that exist, by pair. */
  let existing: Map<string, UnallocatedTurbine>;
  /** Classification per pair (default: what DEMO_TURBINES gives). */
  let classOf: Map<string, string>;

  const key = (turbineId: string, farmId: string) => `${turbineId}@${farmId}`;

  beforeEach(() => {
    vi.mocked(classifyReadings).mockReset();
    vi.mocked(holdReadings).mockReset();
    vi.mocked(blockUnallocated).mockClear();
    prisma = mockDeep<PrismaClient>();
    prisma.$transaction.mockImplementation((fn: unknown) =>
      (fn as (tx: PrismaClient) => Promise<unknown>)(prisma),
    );
    prisma.user.findMany.mockResolvedValue([
      { id: 'admin-id', email: 'admin@nextera.local' },
      { id: 'owner-id', email: 'owner@nextera.local' },
    ] as never);
    existing = new Map();
    classOf = new Map();
    prisma.unallocatedTurbine.findUnique.mockImplementation(((args: {
      where: {
        turbineId_reportedFarmId: { turbineId: string; reportedFarmId: string };
      };
    }) => {
      const { turbineId, reportedFarmId } = args.where.turbineId_reportedFarmId;
      return Promise.resolve(
        existing.get(key(turbineId, reportedFarmId)) ?? null,
      );
    }) as never);
    vi.mocked(classifyReadings).mockImplementation((_tx, [r]) =>
      Promise.resolve([
        (classOf.get(key(r.turbineId, r.farmId)) ??
          (demoFarm.has(r.turbineId)
            ? 'farm_mismatch'
            : 'unknown_turbine')) as never,
      ]),
    );
    vi.mocked(holdReadings).mockImplementation((_tx, readings) =>
      Promise.resolve([
        {
          id: `id-${readings[0].turbineId}`,
          turbineId: readings[0].turbineId,
          reportedFarmId: readings[0].farmId,
          kind: readings[0].kind,
          created: false,
          held: readings.length,
          notify: false,
        } satisfies HeldEntry,
      ]),
    );
  });

  const holdCalls = (turbineId: string) =>
    vi
      .mocked(holdReadings)
      .mock.calls.filter(([, r]) => r[0].turbineId === turbineId)
      .map(([, readings, now]) => ({
        readings: readings as readonly HoldableReading[],
        now,
      }));

  it('creates every entry: the first reading at its receive time, the rest at the newest', async () => {
    const results = await seedDemoUnallocated(prisma, END);

    expect(
      results.map((r) => [r.turbineId, r.outcome, r.kind, r.status, r.held]),
    ).toEqual([
      ['TURB099', 'created', 'unknown_turbine', 'pending', 72],
      ['TURB098', 'created', 'unknown_turbine', 'pending', 36],
      ['TURB003', 'created', 'farm_mismatch', 'pending', 24],
      ['TURB004', 'created', 'farm_mismatch', 'pending', 12],
      ['TURB097', 'created', 'unknown_turbine', 'blocked', 0],
      ['TURB005', 'created', 'farm_mismatch', 'blocked', 0],
    ]);

    const readings = demoUnallocatedReadings(DEMO_UNALLOCATED[0], END);
    const [first, rest] = holdCalls('TURB099');
    expect(first.readings).toEqual([
      { ...readings[0], kind: 'unknown_turbine' },
    ]);
    expect(first.now).toEqual(readings[0].receivedAt);
    expect(rest.readings).toHaveLength(71);
    expect(rest.now).toEqual(readings.at(-1)!.receivedAt);
    expect(prisma.$transaction).toHaveBeenCalledTimes(DEMO_UNALLOCATED.length);
  });

  it('blocks the blocked entries at their offset, by their user', async () => {
    await seedDemoUnallocated(prisma, END);

    expect(vi.mocked(blockUnallocated).mock.calls.map(([, ...a]) => a)).toEqual(
      [
        [
          'id-TURB097',
          {
            blockedAt: new Date(END_MS - 24 * 60 * MIN),
            blockedById: 'admin-id',
          },
        ],
        [
          'id-TURB005',
          {
            blockedAt: new Date(END_MS - 12 * 60 * MIN),
            blockedById: 'owner-id',
          },
        ],
      ],
    );
  });

  it('blocks with no user when the seed user is missing', async () => {
    prisma.user.findMany.mockResolvedValue([]);
    await seedDemoUnallocated(prisma, END);
    expect(
      vi.mocked(blockUnallocated).mock.calls.map(([, , a]) => a.blockedById),
    ).toEqual([null, null]);
  });

  it('tops up an existing pending entry in one hold, never moving last_seen_at back', async () => {
    const lastSeenAt = new Date(END_MS + 3 * 60 * MIN); // the live feed's, later than the seed end
    existing.set(key('TURB099', 'FARM01'), {
      id: 'id-TURB099',
      status: 'pending',
      lastSeenAt,
    } as UnallocatedTurbine);

    const [result] = await seedDemoUnallocated(prisma, END);

    expect(result).toMatchObject({ outcome: 'updated', status: 'pending' });
    const calls = holdCalls('TURB099');
    expect(calls).toHaveLength(1);
    expect(calls[0].readings).toHaveLength(72);
    expect(calls[0].now).toEqual(lastSeenAt);
  });

  it('skips a resolved pair (the turbine is on the reported farm now)', async () => {
    classOf.set(key('TURB099', 'FARM01'), 'known');
    classOf.set(key('TURB003', 'FARM02'), 'known');

    const results = await seedDemoUnallocated(prisma, END);

    for (const turbineId of ['TURB099', 'TURB003']) {
      expect(results.find((r) => r.turbineId === turbineId)).toEqual({
        turbineId,
        reportedFarmId: turbineId === 'TURB099' ? 'FARM01' : 'FARM02',
        outcome: 'resolved',
        kind: null,
        status: null,
        held: 0,
      });
      expect(holdCalls(turbineId)).toEqual([]);
    }
  });

  it('derives the kind from the fleet now (an assigned TURB098 on another farm is a mismatch)', async () => {
    classOf.set(key('TURB098', 'FARM99'), 'farm_mismatch');
    const results = await seedDemoUnallocated(prisma, END);
    expect(results[1]).toMatchObject({
      turbineId: 'TURB098',
      kind: 'farm_mismatch',
    });
    expect(holdCalls('TURB098')[0].readings[0].kind).toBe('farm_mismatch');
  });

  it('leaves blocked entries alone, and never blocks a pending one', async () => {
    // A user blocked a planned pending pair; a planned blocked pair is pending (unblocked, then
    // a reading arrived).
    classOf.set(key('TURB003', 'FARM02'), 'blocked');
    existing.set(key('TURB003', 'FARM02'), {
      id: 'x',
      status: 'blocked',
      kind: 'farm_mismatch',
    } as UnallocatedTurbine);
    existing.set(key('TURB097', 'FARM05'), {
      id: 'y',
      status: 'pending',
      kind: 'unknown_turbine',
    } as UnallocatedTurbine);

    const results = await seedDemoUnallocated(prisma, END);

    expect(results.find((r) => r.turbineId === 'TURB003')).toMatchObject({
      outcome: 'unchanged',
      status: 'blocked',
    });
    expect(results.find((r) => r.turbineId === 'TURB097')).toMatchObject({
      outcome: 'unchanged',
      status: 'pending',
    });
    expect(holdCalls('TURB003')).toEqual([]);
    expect(holdCalls('TURB097')).toEqual([]);
    expect(vi.mocked(blockUnallocated).mock.calls.map(([, id]) => id)).toEqual([
      'id-TURB005',
    ]);
  });
});
