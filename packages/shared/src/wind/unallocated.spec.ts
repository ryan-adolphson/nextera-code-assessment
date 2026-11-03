import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import type {
  HeldTelemetry,
  PrismaClient,
  Telemetry,
  UnallocatedTurbine,
} from '../generated/prisma/client.js';
import { getUnallocated, heldReadings, listUnallocated } from './queries.js';
import { QueryNotFoundError } from './queries.js';
import {
  HELD_RETENTION_MS,
  MAX_PENDING_UNALLOCATED,
  UnallocatedCapError,
  classifyReadings,
  holdReadings,
  importHeld,
  lockUnallocated,
  toUnallocatedResponse,
  type HoldableReading,
} from './unallocated.js';

const ID = '0b3c7a1e-8f7d-4a4e-9c11-2f1d6c3b9a10';
const NOW = new Date('2026-03-01T00:10:30Z');

const row = (overrides: Partial<HoldableReading> = {}): HoldableReading => ({
  turbineId: 'TURB999',
  farmId: 'FARM01',
  timestamp: new Date('2026-03-01T00:00:00Z'),
  receivedAt: new Date('2026-03-01T00:01:00Z'),
  powerOutputKw: 2000,
  windSpeedMs: 8,
  rotorRpm: 14,
  bladePitchDeg: 3.6,
  gearboxTempC: 81.6,
  kind: 'unknown_turbine',
  ...overrides,
});

const entry = (
  overrides: Partial<UnallocatedTurbine> = {},
): UnallocatedTurbine => ({
  id: ID,
  turbineId: 'TURB999',
  reportedFarmId: 'FARM01',
  kind: 'unknown_turbine',
  status: 'pending',
  firstSeenAt: new Date('2026-03-01T00:00:00Z'),
  lastSeenAt: new Date('2026-03-01T00:05:00Z'),
  blockedAt: null,
  blockedById: null,
  createdAt: new Date('2026-03-01T00:00:00Z'),
  updatedAt: new Date('2026-03-01T00:05:00Z'),
  ...overrides,
});

const held = (overrides: Partial<HeldTelemetry> = {}): HeldTelemetry => {
  const { kind: _kind, ...reading } = row();
  return {
    ...reading,
    id: 'held-1',
    unallocatedId: ID,
    createdAt: new Date('2026-03-01T00:01:00Z'),
    ...overrides,
  };
};

describe('unallocated turbines', () => {
  let db: DeepMockProxy<PrismaClient>;

  beforeEach(() => {
    db = mockDeep<PrismaClient>();
    db.turbine.findMany.mockResolvedValue([
      { turbineId: 'TURB001', farmId: 'FARM01' },
    ] as never);
    db.unallocatedTurbine.findMany.mockResolvedValue([]);
  });

  describe('classifyReadings', () => {
    it('classifies known readings without a lock or a blocked lookup', async () => {
      await expect(
        classifyReadings(db, [{ turbineId: 'TURB001', farmId: 'FARM01' }]),
      ).resolves.toEqual(['known']);
      expect(db.$executeRaw).not.toHaveBeenCalled();
      expect(db.unallocatedTurbine.findMany).not.toHaveBeenCalled();
    });

    it('locks the other turbine ids, then classifies them again: unknown, mismatch or blocked', async () => {
      db.unallocatedTurbine.findMany.mockResolvedValue([
        { turbineId: 'TURB998', reportedFarmId: 'FARM01' },
      ] as never);

      const kinds = await classifyReadings(db, [
        { turbineId: 'TURB001', farmId: 'FARM01' },
        { turbineId: 'TURB001', farmId: 'FARM02' },
        { turbineId: 'TURB999', farmId: 'FARM01' },
        { turbineId: 'TURB998', farmId: 'FARM01' },
        { turbineId: 'TURB998', farmId: 'FARM02' }, // another farm: not blocked
      ]);

      expect(kinds).toEqual([
        'known',
        'farm_mismatch',
        'unknown_turbine',
        'blocked',
        'unknown_turbine',
      ]);
      // Locked (sorted, once each) before the second turbine lookup.
      expect(db.$executeRaw).toHaveBeenCalledOnce();
      expect(db.$executeRaw.mock.calls[0][1]).toEqual([
        'TURB001',
        'TURB998',
        'TURB999',
      ]);
      expect(db.turbine.findMany).toHaveBeenLastCalledWith({
        where: { turbineId: { in: ['TURB001', 'TURB998', 'TURB999'] } },
        select: { turbineId: true, farmId: true },
      });
      expect(db.$executeRaw.mock.invocationCallOrder[0]).toBeLessThan(
        db.turbine.findMany.mock.invocationCallOrder[1],
      );
    });

    it('sees a turbine created by an assign that committed while it waited for the lock', async () => {
      db.turbine.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          { turbineId: 'TURB999', farmId: 'FARM01' },
        ] as never);

      await expect(
        classifyReadings(db, [{ turbineId: 'TURB999', farmId: 'FARM01' }]),
      ).resolves.toEqual(['known']);
    });
  });

  describe('holdReadings', () => {
    beforeEach(() => {
      db.$queryRaw.mockResolvedValue([] as never);
      db.unallocatedTurbine.count.mockResolvedValue(0);
      db.unallocatedTurbine.create.mockResolvedValue({ id: ID } as never);
      db.heldTelemetry.createMany.mockImplementation(((args: {
        data: unknown[];
      }) => Promise.resolve({ count: args.data.length })) as never);
    });

    it('creates a pending entry per pair, holds its readings idempotently and prunes to the retention', async () => {
      const entries = await holdReadings(
        db,
        [
          row(),
          row({ timestamp: new Date('2026-03-01T00:05:00Z') }),
          row({
            turbineId: 'TURB001',
            farmId: 'FARM02',
            kind: 'farm_mismatch',
          }),
        ],
        NOW,
      );

      expect(entries).toEqual([
        {
          id: ID,
          turbineId: 'TURB999',
          reportedFarmId: 'FARM01',
          kind: 'unknown_turbine',
          created: true,
          held: 2,
          notify: true,
        },
        expect.objectContaining({
          turbineId: 'TURB001',
          reportedFarmId: 'FARM02',
          kind: 'farm_mismatch',
          created: true,
          held: 1,
        }),
      ]);
      expect(db.unallocatedTurbine.create).toHaveBeenCalledWith({
        data: {
          turbineId: 'TURB999',
          reportedFarmId: 'FARM01',
          kind: 'unknown_turbine',
          firstSeenAt: NOW,
          lastSeenAt: NOW,
        },
        select: { id: true },
      });
      const { kind: _kind, ...stored } = row();
      expect(db.heldTelemetry.createMany).toHaveBeenNthCalledWith(1, {
        data: [
          { ...stored, unallocatedId: ID },
          expect.objectContaining({
            timestamp: new Date('2026-03-01T00:05:00Z'),
          }),
        ],
        skipDuplicates: true,
      });
      // The entry row is locked FOR UPDATE; the retention prune is one DELETE per entry.
      expect(String(db.$queryRaw.mock.calls[0][0])).toContain('FOR UPDATE');
      const prune = db.$executeRaw.mock.calls.find(([sql]) =>
        String(sql).includes('DELETE FROM held_telemetry'),
      );
      expect(prune).toContainEqual(HELD_RETENTION_MS / 1000);
    });

    it('updates an existing entry and announces it at most once a minute', async () => {
      db.$queryRaw.mockResolvedValue([
        {
          id: ID,
          status: 'pending',
          last_seen_at: new Date('2026-03-01T00:10:05Z'),
        },
      ] as never);

      const [same] = await holdReadings(
        db,
        [row({ kind: 'farm_mismatch' })],
        NOW,
      );
      expect(same).toMatchObject({ created: false, held: 1, notify: false });
      expect(db.unallocatedTurbine.update).toHaveBeenCalledWith({
        where: { id: ID },
        data: { lastSeenAt: NOW, kind: 'farm_mismatch' },
      });
      expect(db.unallocatedTurbine.create).not.toHaveBeenCalled();

      const [later] = await holdReadings(
        db,
        [row()],
        new Date('2026-03-01T00:11:00Z'),
      );
      expect(later.notify).toBe(true);

      db.heldTelemetry.createMany.mockResolvedValue({ count: 0 });
      const [duplicate] = await holdReadings(
        db,
        [row()],
        new Date('2026-03-01T00:12:00Z'),
      );
      expect(duplicate).toMatchObject({ held: 0, notify: false });
    });

    it('rejects new pairs over the cap, naming each, but checks every pair first', async () => {
      db.unallocatedTurbine.count.mockResolvedValue(
        MAX_PENDING_UNALLOCATED - 1,
      );

      const error = await holdReadings(
        db,
        [
          row({ turbineId: 'TURB997' }),
          row({ turbineId: 'TURB998' }),
          row({ turbineId: 'TURB999' }),
        ],
        NOW,
      ).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(UnallocatedCapError);
      expect((error as UnallocatedCapError).pairs).toEqual([
        { turbineId: 'TURB998', farmId: 'FARM01' },
        { turbineId: 'TURB999', farmId: 'FARM01' },
      ]);
      expect(db.unallocatedTurbine.count).toHaveBeenCalledOnce();
    });

    it('refuses to hold for a blocked pair (classify first, in the same transaction)', async () => {
      db.$queryRaw.mockResolvedValue([
        { id: ID, status: 'blocked', last_seen_at: NOW },
      ] as never);

      await expect(holdReadings(db, [row()], NOW)).rejects.toThrow(
        'TURB999 on FARM01 is blocked',
      );
      expect(db.heldTelemetry.createMany).not.toHaveBeenCalled();
    });
  });

  describe('lockUnallocated', () => {
    it('returns null for an unknown entry without locking', async () => {
      db.unallocatedTurbine.findUnique.mockResolvedValue(null);
      await expect(lockUnallocated(db, ID)).resolves.toBeNull();
      expect(db.$executeRaw).not.toHaveBeenCalled();
    });

    it('returns null when the entry was deleted while it waited for the lock', async () => {
      db.unallocatedTurbine.findUnique.mockResolvedValue(entry());
      db.$queryRaw.mockResolvedValue([] as never);
      await expect(lockUnallocated(db, ID)).resolves.toBeNull();
      expect(db.$executeRaw.mock.calls[0][1]).toEqual(['TURB999']);
    });
  });

  describe('importHeld', () => {
    it('inserts the held readings under the farm with their alerts, deletes the entry and returns the newest', async () => {
      db.heldTelemetry.findMany.mockResolvedValue([
        held(),
        held({
          id: 'held-2',
          timestamp: new Date('2026-03-01T00:05:00Z'),
          gearboxTempC: 130,
        }),
      ]);
      db.alertConfig.findMany.mockResolvedValue([
        {
          id: 'rule',
          measurementMetric: 'gearboxTempC',
          comparison: 'above',
          valueMetric: 100,
          alertLevel: 'error',
          enabled: true,
        },
      ]);
      db.telemetry.createManyAndReturn.mockImplementation(((args: {
        data: Omit<Telemetry, 'id' | 'createdAt'>[];
      }) =>
        Promise.resolve(
          args.data.map((r, i) => ({ ...r, id: `t${i}`, createdAt: NOW })),
        )) as never);

      const result = await importHeld(db, ID, 'FARM03');

      expect(db.telemetry.createManyAndReturn.mock.calls[0]?.[0]?.data).toEqual(
        [
          expect.objectContaining({ turbineId: 'TURB999', farmId: 'FARM03' }),
          expect.objectContaining({ farmId: 'FARM03', gearboxTempC: 130 }),
        ],
      );
      expect(db.telemetryAlert.createMany).toHaveBeenCalledWith({
        data: [{ telemetryId: 't1', alertId: 'rule' }],
      });
      expect(db.unallocatedTurbine.delete).toHaveBeenCalledWith({
        where: { id: ID },
      });
      expect(result).toMatchObject({
        imported: 2,
        duplicates: 0,
        newest: { id: 't1', timestamp: new Date('2026-03-01T00:05:00Z') },
      });
    });

    it('deletes an entry without held readings and returns no newest reading', async () => {
      db.heldTelemetry.findMany.mockResolvedValue([]);
      await expect(importHeld(db, ID, 'FARM01')).resolves.toEqual({
        imported: 0,
        duplicates: 0,
        newest: null,
      });
      expect(db.telemetry.createManyAndReturn).not.toHaveBeenCalled();
      expect(db.unallocatedTurbine.delete).toHaveBeenCalled();
    });
  });

  describe('responses and read queries', () => {
    it('derives the kind from the turbine’s current farm and exposes no internal ids but the entry’s', () => {
      const response = toUnallocatedResponse({
        entry: { ...entry({ kind: 'unknown_turbine' }), blockedBy: null },
        heldCount: 3,
        latest: held(),
        reportedFarm: null,
        currentFarm: { id: 'FARM02', name: 'High Plains' },
      });
      expect(response).toMatchObject({
        kind: 'farm_mismatch', // the turbine exists by now
        reportedFarm: null,
        currentFarm: { id: 'FARM02', name: 'High Plains' },
        heldCount: 3,
        blockedBy: null,
      });
      expect(response.latest).not.toHaveProperty('id');
      expect(response.latest).not.toHaveProperty('unallocatedId');
    });

    it('lists entries with held count, newest reading, reported and current farm', async () => {
      db.unallocatedTurbine.findMany.mockResolvedValue([
        {
          ...entry({
            turbineId: 'TURB001',
            reportedFarmId: 'FARM02',
            kind: 'farm_mismatch',
          }),
          blockedBy: null,
          _count: { held: 2 },
        },
      ] as never);
      db.$queryRaw.mockResolvedValue([
        {
          id: 'held-1',
          unallocated_id: ID,
          turbine_id: 'TURB001',
          farm_id: 'FARM02',
          timestamp: new Date('2026-03-01T00:05:00Z'),
          received_at: new Date('2026-03-01T00:06:00Z'),
          created_at: NOW,
          power_output_kw: 1,
          wind_speed_ms: 2,
          rotor_rpm: 3,
          blade_pitch_deg: 4,
          gearbox_temp_c: 5,
        },
      ] as never);
      db.farm.findMany.mockResolvedValue([
        { id: 'FARM01', name: 'Prairie Ridge' },
        { id: 'FARM02', name: 'High Plains' },
      ] as never);

      const [listed] = await listUnallocated(db, { status: 'pending' });

      expect(db.unallocatedTurbine.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'pending' } }),
      );
      expect(listed).toMatchObject({
        kind: 'farm_mismatch',
        reportedFarm: { id: 'FARM02', name: 'High Plains' },
        currentFarm: { id: 'FARM01', name: 'Prairie Ridge' },
        heldCount: 2,
        latest: {
          turbineId: 'TURB001',
          farmId: 'FARM02',
          timestamp: '2026-03-01T00:05:00.000Z',
          gearboxTempC: 5,
        },
      });
    });

    it('returns no entries without further queries', async () => {
      await expect(listUnallocated(db)).resolves.toEqual([]);
      expect(db.$queryRaw).not.toHaveBeenCalled();
    });

    it('404s (QueryNotFoundError) an unknown entry', async () => {
      db.unallocatedTurbine.findUnique.mockResolvedValue(null);
      await expect(heldReadings(db, ID, 10)).rejects.toBeInstanceOf(
        QueryNotFoundError,
      );
      await expect(getUnallocated(db, ID)).rejects.toThrow(
        `Unallocated turbine ${ID} not found`,
      );
    });
  });
});
