import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  EventStore,
  FLEET_CHANGED,
  Prisma,
  PrismaService,
  TELEMETRY_RECEIVED,
  UNALLOCATED_CHANGED,
  type Farm,
  type HeldTelemetry,
  type Telemetry,
  type Turbine,
  type UnallocatedTurbine,
} from '@nextera/shared';
import { FarmsCacheService } from '../farms-cache/farms-cache.service.js';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { UnallocatedTurbinesService } from './unallocated-turbines.service.js';

const ID = '0b3c7a1e-8f7d-4a4e-9c11-2f1d6c3b9a10';
const USER: AuthenticatedUser = {
  id: '5f0c3b7a-2d1e-4c6b-9a8f-1e2d3c4b5a69',
  email: 'owner@nextera.local',
  role: 'owner',
  expiresAt: new Date('2026-03-02T00:00:00Z'),
};

const entry = (
  overrides: Partial<UnallocatedTurbine> = {},
): UnallocatedTurbine => ({
  id: ID,
  turbineId: 'TURB999',
  reportedFarmId: 'FARM01',
  kind: 'unknown_turbine',
  status: 'pending',
  firstSeenAt: new Date('2026-03-01T00:00:00Z'),
  lastSeenAt: new Date('2026-03-01T00:10:00Z'),
  blockedAt: null,
  blockedById: null,
  createdAt: new Date('2026-03-01T00:00:00Z'),
  updatedAt: new Date('2026-03-01T00:10:00Z'),
  ...overrides,
});

const farm = (id = 'FARM01'): Farm => ({
  id,
  name: 'Prairie Ridge',
  latitude: new Prisma.Decimal(41.25),
  longitude: new Prisma.Decimal(-96.53),
});

const turbine = (overrides: Partial<Turbine> = {}): Turbine => ({
  id: 'internal-uuid',
  turbineId: 'TURB999',
  farmId: 'FARM01',
  latitude: new Prisma.Decimal(41.25),
  longitude: new Prisma.Decimal(-96.53),
  commissioned: false,
  ...overrides,
});

const held = (minute: number): HeldTelemetry => ({
  id: `held-${minute}`,
  unallocatedId: ID,
  turbineId: 'TURB999',
  farmId: 'FARM01',
  timestamp: new Date(`2026-03-01T00:${String(minute).padStart(2, '0')}:00Z`),
  receivedAt: new Date('2026-03-01T00:30:00Z'),
  createdAt: new Date('2026-03-01T00:30:00Z'),
  powerOutputKw: 2000 + minute,
  windSpeedMs: 8,
  rotorRpm: 14,
  bladePitchDeg: 3.6,
  gearboxTempC: 81.6,
});

describe('UnallocatedTurbinesService', () => {
  let service: UnallocatedTurbinesService;
  let prisma: DeepMockProxy<PrismaService>;
  let events: DeepMockProxy<EventStore>;
  let farmsCache: DeepMockProxy<FarmsCacheService>;
  /** events.publish calls made while a transaction was still open (must stay 0). */
  let publishedInsideTransaction: number;

  beforeEach(async () => {
    prisma = mockDeep<PrismaService>();
    events = mockDeep<EventStore>();
    farmsCache = mockDeep<FarmsCacheService>();
    events.publish.mockResolvedValue({ id: '1-0', type: '', data: null });
    publishedInsideTransaction = 0;
    prisma.$transaction.mockImplementation(async (fn: unknown) => {
      const before = events.publish.mock.calls.length;
      const result = await (fn as (tx: PrismaService) => Promise<unknown>)(
        prisma,
      );
      publishedInsideTransaction += events.publish.mock.calls.length - before;
      return result;
    });
    // lockUnallocated: find the entry, lock its turbine id, then SELECT … FOR UPDATE.
    prisma.unallocatedTurbine.findUnique.mockResolvedValue(entry());
    prisma.$queryRaw.mockResolvedValue([{ id: ID }] as never);
    prisma.turbine.findUnique.mockResolvedValue(null);
    prisma.farm.findUnique.mockResolvedValue(farm());
    prisma.turbine.create.mockImplementation(((args: {
      data: Omit<Turbine, 'latitude' | 'longitude'> & {
        latitude: Prisma.Decimal | number;
        longitude: Prisma.Decimal | number;
      };
    }) =>
      Promise.resolve(
        turbine({
          ...args.data,
          latitude: new Prisma.Decimal(args.data.latitude),
          longitude: new Prisma.Decimal(args.data.longitude),
        }),
      )) as never);
    prisma.heldTelemetry.findMany.mockResolvedValue([held(0), held(5)]);
    prisma.alertConfig.findMany.mockResolvedValue([]);
    prisma.telemetry.createManyAndReturn.mockImplementation(((args: {
      data: Omit<Telemetry, 'id' | 'createdAt'>[];
    }) =>
      Promise.resolve(
        args.data.map((row, i) => ({
          ...row,
          id: `telemetry-${i}`,
          createdAt: new Date(),
        })),
      )) as never);

    const moduleRef = await Test.createTestingModule({
      providers: [
        UnallocatedTurbinesService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventStore, useValue: events },
        { provide: FarmsCacheService, useValue: farmsCache },
      ],
    }).compile();
    service = moduleRef.get(UnallocatedTurbinesService);
  });

  afterEach(() => {
    expect(publishedInsideTransaction).toBe(0);
  });

  const publishedTypes = () => events.publish.mock.calls.map(([type]) => type);

  describe('assign', () => {
    it('creates the turbine on the farm (its coordinates), imports the held readings and publishes after the commit', async () => {
      const result = await service.assign(ID, { farmId: 'FARM01' });

      expect(result).toEqual({
        action: 'assigned',
        id: ID,
        turbine: {
          id: 'TURB999',
          farmId: 'FARM01',
          latitude: 41.25,
          longitude: -96.53,
          commissioned: false,
        },
        imported: 2,
        duplicates: 0,
      });
      expect(prisma.turbine.create).toHaveBeenCalledWith({
        data: {
          turbineId: 'TURB999',
          farmId: 'FARM01',
          latitude: farm().latitude,
          longitude: farm().longitude,
        },
      });
      expect(prisma.telemetry.createManyAndReturn).toHaveBeenCalledWith({
        data: [
          expect.objectContaining({
            turbineId: 'TURB999',
            farmId: 'FARM01',
            timestamp: held(0).timestamp,
            receivedAt: held(0).receivedAt,
          }),
          expect.objectContaining({ timestamp: held(5).timestamp }),
        ],
        skipDuplicates: true,
      });
      expect(prisma.unallocatedTurbine.delete).toHaveBeenCalledWith({
        where: { id: ID },
      });
      expect(prisma.unallocatedTurbine.updateMany).toHaveBeenCalledWith({
        where: { turbineId: 'TURB999', id: { not: ID } },
        data: { kind: 'farm_mismatch' },
      });
      expect(publishedTypes()).toEqual([
        UNALLOCATED_CHANGED,
        FLEET_CHANGED,
        TELEMETRY_RECEIVED,
      ]);
      expect(farmsCache.invalidate).toHaveBeenCalledOnce();
      expect(events.publish).toHaveBeenNthCalledWith(1, UNALLOCATED_CHANGED, {
        action: 'assigned',
        id: ID,
        turbineId: 'TURB999',
      });
      expect(events.publish).toHaveBeenNthCalledWith(2, FLEET_CHANGED, {
        turbineId: 'TURB999',
      });
      expect(events.publish.mock.calls[2][1]).toMatchObject({
        turbineId: 'TURB999',
        timestamp: '2026-03-01T00:05:00.000Z', // the newest imported reading
      });
    });

    it('locks the entry before reading it (advisory lock, then FOR UPDATE)', async () => {
      await service.assign(ID, { farmId: 'FARM01' });

      const lock = prisma.$executeRaw.mock.invocationCallOrder[0];
      const forUpdate = prisma.$queryRaw.mock.invocationCallOrder[0];
      expect(lock).toBeLessThan(forUpdate);
      expect(String(prisma.$queryRaw.mock.calls[0][0])).toContain('FOR UPDATE');
      expect(forUpdate).toBeLessThan(
        prisma.turbine.create.mock.invocationCallOrder[0],
      );
    });

    it('uses the given coordinates', async () => {
      await service.assign(ID, {
        farmId: 'FARM01',
        latitude: 41.3,
        longitude: -96.6,
      });

      expect(prisma.turbine.create).toHaveBeenCalledWith({
        data: expect.objectContaining({ latitude: 41.3, longitude: -96.6 }),
      });
    });

    it('rejects only one coordinate with 400, before any transaction', async () => {
      await expect(
        service.assign(ID, { farmId: 'FARM01', latitude: 41 }),
      ).rejects.toThrow(
        new BadRequestException(
          'Provide both latitude and longitude, or neither',
        ),
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('404s an unknown entry (or one deleted by a concurrent action)', async () => {
      prisma.$queryRaw.mockResolvedValue([] as never);

      await expect(service.assign(ID, { farmId: 'FARM01' })).rejects.toThrow(
        new NotFoundException(`Unallocated turbine ${ID} not found`),
      );
      expect(events.publish).not.toHaveBeenCalled();
    });

    it('409s a blocked entry', async () => {
      prisma.unallocatedTurbine.findUnique.mockResolvedValue(
        entry({ status: 'blocked' }),
      );

      await expect(service.assign(ID, { farmId: 'FARM01' })).rejects.toThrow(
        new ConflictException(
          'TURB999 reporting FARM01 is blocked: unblock it first',
        ),
      );
    });

    it('409s when the turbine id is in the fleet by now, writing nothing', async () => {
      prisma.turbine.findUnique.mockResolvedValue(
        turbine({ farmId: 'FARM02' }),
      );

      await expect(service.assign(ID, { farmId: 'FARM01' })).rejects.toThrow(
        new ConflictException(
          'Turbine TURB999 already exists on FARM02: keep or move it instead',
        ),
      );
      expect(prisma.turbine.create).not.toHaveBeenCalled();
      expect(events.publish).not.toHaveBeenCalled();
    });

    it('404s an unknown farm', async () => {
      prisma.farm.findUnique.mockResolvedValue(null);

      await expect(service.assign(ID, { farmId: 'FARM99' })).rejects.toThrow(
        new NotFoundException('Farm FARM99 not found'),
      );
      expect(prisma.turbine.create).not.toHaveBeenCalled();
    });

    it('still answers when publishing fails (the change is committed)', async () => {
      events.publish.mockRejectedValue(new Error('redis down'));
      vi.spyOn(service['logger'], 'error').mockImplementation(() => undefined);

      await expect(
        service.assign(ID, { farmId: 'FARM01' }),
      ).resolves.toMatchObject({ action: 'assigned', imported: 2 });
    });
  });

  describe('keep', () => {
    beforeEach(() => {
      prisma.unallocatedTurbine.findUnique.mockResolvedValue(
        entry({
          turbineId: 'TURB001',
          reportedFarmId: 'FARM02',
          kind: 'farm_mismatch',
        }),
      );
    });

    it('imports the held readings under the turbine’s own farm', async () => {
      prisma.turbine.findUnique.mockResolvedValue(
        turbine({ turbineId: 'TURB001', farmId: 'FARM01' }),
      );

      const result = await service.keep(ID);

      expect(result).toMatchObject({
        action: 'kept',
        turbine: { id: 'TURB001', farmId: 'FARM01' },
        imported: 2,
      });
      expect(
        prisma.telemetry.createManyAndReturn.mock.calls[0][0]?.data,
      ).toEqual([
        expect.objectContaining({ farmId: 'FARM01' }),
        expect.objectContaining({ farmId: 'FARM01' }),
      ]);
      expect(prisma.turbine.update).not.toHaveBeenCalled();
      expect(publishedTypes()).toEqual([
        UNALLOCATED_CHANGED,
        FLEET_CHANGED,
        TELEMETRY_RECEIVED,
      ]);
    });

    it('409s an unknown turbine (assign it instead)', async () => {
      await expect(service.keep(ID)).rejects.toThrow(
        new ConflictException(
          'Turbine TURB001 is not in the fleet: assign it to a farm instead',
        ),
      );
    });

    it('counts held readings telemetry already has as duplicates, and publishes no reading when none is new', async () => {
      prisma.turbine.findUnique.mockResolvedValue(
        turbine({ turbineId: 'TURB001', farmId: 'FARM01' }),
      );
      prisma.telemetry.createManyAndReturn.mockResolvedValue([]);

      await expect(service.keep(ID)).resolves.toMatchObject({
        imported: 0,
        duplicates: 2,
      });
      expect(publishedTypes()).toEqual([UNALLOCATED_CHANGED, FLEET_CHANGED]);
    });
  });

  describe('move', () => {
    beforeEach(() => {
      prisma.unallocatedTurbine.findUnique.mockResolvedValue(
        entry({
          turbineId: 'TURB001',
          reportedFarmId: 'FARM02',
          kind: 'farm_mismatch',
        }),
      );
      prisma.turbine.findUnique.mockResolvedValue(
        turbine({ turbineId: 'TURB001', farmId: 'FARM01' }),
      );
    });

    it('moves the turbine (its history follows by ON UPDATE CASCADE) and imports under the new farm', async () => {
      prisma.farm.findUnique.mockResolvedValue(farm('FARM02'));
      prisma.turbine.update.mockResolvedValue(
        turbine({ turbineId: 'TURB001', farmId: 'FARM02' }),
      );

      const result = await service.move(ID);

      expect(prisma.turbine.update).toHaveBeenCalledWith({
        where: { turbineId: 'TURB001' },
        data: { farmId: 'FARM02' },
      });
      expect(prisma.turbine.update.mock.invocationCallOrder[0]).toBeLessThan(
        prisma.telemetry.createManyAndReturn.mock.invocationCallOrder[0],
      );
      expect(result).toMatchObject({
        action: 'moved',
        turbine: { id: 'TURB001', farmId: 'FARM02' },
        imported: 2,
      });
      expect(
        prisma.telemetry.createManyAndReturn.mock.calls[0][0]?.data,
      ).toEqual([
        expect.objectContaining({ farmId: 'FARM02' }),
        expect.objectContaining({ farmId: 'FARM02' }),
      ]);
    });

    it('409s when the reported farm does not exist', async () => {
      prisma.farm.findUnique.mockResolvedValue(null);

      await expect(service.move(ID)).rejects.toThrow(
        new ConflictException(
          'Farm FARM02 does not exist: keep TURB001 in FARM01 or block it',
        ),
      );
      expect(prisma.turbine.update).not.toHaveBeenCalled();
    });
  });

  describe('block', () => {
    it('blocks the pair, records who and when, deletes the held readings and publishes', async () => {
      vi.useFakeTimers({ now: new Date('2026-03-01T12:00:00Z') });
      try {
        // getUnallocated after the update (inside the transaction).
        prisma.$queryRaw
          .mockResolvedValueOnce([{ id: ID }] as never) // FOR UPDATE
          .mockResolvedValueOnce([] as never); // newest held reading: none left
        prisma.unallocatedTurbine.findMany.mockResolvedValue([
          {
            ...entry({
              status: 'blocked',
              blockedAt: new Date('2026-03-01T12:00:00Z'),
              blockedById: USER.id,
            }),
            blockedBy: { email: USER.email },
            _count: { held: 0 },
          },
        ] as never);
        prisma.turbine.findMany.mockResolvedValue([]);
        prisma.farm.findMany.mockResolvedValue([
          { id: 'FARM01', name: 'Prairie Ridge' },
        ] as never);

        const result = await service.block(ID, USER);

        expect(prisma.unallocatedTurbine.update).toHaveBeenCalledWith({
          where: { id: ID },
          data: {
            status: 'blocked',
            blockedAt: new Date('2026-03-01T12:00:00Z'),
            blockedById: USER.id,
          },
        });
        expect(prisma.heldTelemetry.deleteMany).toHaveBeenCalledWith({
          where: { unallocatedId: ID },
        });
        expect(result).toEqual({
          id: ID,
          turbineId: 'TURB999',
          kind: 'unknown_turbine',
          status: 'blocked',
          reportedFarmId: 'FARM01',
          reportedFarm: { id: 'FARM01', name: 'Prairie Ridge' },
          currentFarm: null,
          firstSeenAt: '2026-03-01T00:00:00.000Z',
          lastSeenAt: '2026-03-01T00:10:00.000Z',
          heldCount: 0,
          latest: null,
          blockedAt: '2026-03-01T12:00:00.000Z',
          blockedBy: 'owner@nextera.local',
        });
        expect(events.publish).toHaveBeenCalledExactlyOnceWith(
          UNALLOCATED_CHANGED,
          { action: 'blocked', id: ID, turbineId: 'TURB999' },
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('409s an entry that is blocked already', async () => {
      prisma.unallocatedTurbine.findUnique.mockResolvedValue(
        entry({ status: 'blocked' }),
      );

      await expect(service.block(ID, USER)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.unallocatedTurbine.update).not.toHaveBeenCalled();
    });
  });

  describe('unblock', () => {
    it('deletes a blocked entry and publishes', async () => {
      prisma.unallocatedTurbine.findUnique.mockResolvedValue(
        entry({ status: 'blocked' }),
      );

      await service.unblock(ID);

      expect(prisma.unallocatedTurbine.delete).toHaveBeenCalledWith({
        where: { id: ID },
      });
      expect(events.publish).toHaveBeenCalledExactlyOnceWith(
        UNALLOCATED_CHANGED,
        { action: 'unblocked', id: ID, turbineId: 'TURB999' },
      );
    });

    it('409s a pending entry', async () => {
      await expect(service.unblock(ID)).rejects.toThrow(
        new ConflictException('TURB999 reporting FARM01 is not blocked'),
      );
      expect(prisma.unallocatedTurbine.delete).not.toHaveBeenCalled();
    });
  });

  describe('readings', () => {
    it('404s an unknown entry', async () => {
      prisma.unallocatedTurbine.findUnique.mockResolvedValue(null);

      await expect(service.readings(ID, 24)).rejects.toThrow(
        new NotFoundException(`Unallocated turbine ${ID} not found`),
      );
    });

    it('returns the newest held readings without internal ids', async () => {
      prisma.heldTelemetry.findMany.mockResolvedValue([held(5)]);

      expect(await service.readings(ID, 24)).toEqual([
        {
          turbineId: 'TURB999',
          farmId: 'FARM01',
          timestamp: '2026-03-01T00:05:00.000Z',
          receivedAt: '2026-03-01T00:30:00.000Z',
          powerOutputKw: 2005,
          windSpeedMs: 8,
          rotorRpm: 14,
          bladePitchDeg: 3.6,
          gearboxTempC: 81.6,
        },
      ]);
      expect(prisma.heldTelemetry.findMany).toHaveBeenCalledWith({
        where: { unallocatedId: ID },
        orderBy: { timestamp: 'desc' },
        take: 24,
      });
    });
  });
});
