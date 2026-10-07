import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  ALERT_CONFIG_CHANGED,
  EventStore,
  Prisma,
  PrismaService,
  type AlertConfig,
} from '@nextera/shared';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { AlertConfigsService } from './alert-configs.service.js';

const ID = '0b3c7a1e-8f7d-4a4e-9c11-2f1d6c3b9a10';

const row = (overrides: Partial<AlertConfig> = {}): AlertConfig => ({
  id: ID,
  measurementMetric: 'gearboxTempC',
  comparison: 'above',
  valueMetric: 120,
  alertLevel: 'error',
  enabled: true,
  ...overrides,
});

const prismaError = (code: string) =>
  new Prisma.PrismaClientKnownRequestError('internal detail', {
    code,
    clientVersion: 'test',
  });

describe('AlertConfigsService', () => {
  let service: AlertConfigsService;
  let prisma: DeepMockProxy<PrismaService>;
  let events: DeepMockProxy<EventStore>;

  beforeEach(async () => {
    prisma = mockDeep<PrismaService>();
    events = mockDeep<EventStore>();
    events.publish.mockResolvedValue({ id: '1-0', type: '', data: null });
    const moduleRef = await Test.createTestingModule({
      providers: [
        AlertConfigsService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventStore, useValue: events },
      ],
    }).compile();
    service = moduleRef.get(AlertConfigsService);
  });

  describe('list', () => {
    it('orders by metric, level severity, then value, and maps every row', async () => {
      prisma.alertConfig.findMany.mockResolvedValue([row()]);

      expect(await service.list()).toEqual([
        {
          id: ID,
          measurementMetric: 'gearboxTempC',
          comparison: 'above',
          valueMetric: 120,
          alertLevel: 'error',
          enabled: true,
        },
      ]);
      expect(prisma.alertConfig.findMany).toHaveBeenCalledWith({
        orderBy: [
          { measurementMetric: 'asc' },
          { alertLevel: 'asc' },
          { valueMetric: 'asc' },
          { comparison: 'asc' },
          { id: 'asc' },
        ],
      });
    });
  });

  describe('get', () => {
    it('returns one rule', async () => {
      prisma.alertConfig.findUnique.mockResolvedValue(row());
      await expect(service.get(ID)).resolves.toMatchObject({ id: ID });
    });

    it('throws NotFoundException for an unknown id', async () => {
      prisma.alertConfig.findUnique.mockResolvedValue(null);
      await expect(service.get(ID)).rejects.toThrow(
        new NotFoundException(`Alert config ${ID} not found`),
      );
    });
  });

  describe('create', () => {
    const dto = {
      measurementMetric: 'gearboxTempC',
      comparison: 'above',
      valueMetric: 120,
      alertLevel: 'error',
    } as const;

    it('stores the rule, then publishes alert-config.changed', async () => {
      const order: string[] = [];
      prisma.alertConfig.create.mockImplementation((() => {
        order.push('db');
        return Promise.resolve(row());
      }) as never);
      events.publish.mockImplementation(async () => {
        order.push('publish');
        return { id: '1-0', type: '', data: null };
      });

      const created = await service.create(dto);

      expect(prisma.alertConfig.create).toHaveBeenCalledWith({ data: dto });
      expect(created).toEqual({ id: ID, ...dto, enabled: true });
      expect(events.publish).toHaveBeenCalledWith(ALERT_CONFIG_CHANGED, {
        action: 'created',
        id: ID,
        config: created,
      });
      expect(order).toEqual(['db', 'publish']);
    });

    it('stores enabled when given, and leaves it to the database default otherwise', async () => {
      prisma.alertConfig.create.mockResolvedValue(row({ enabled: false }));

      const created = await service.create({ ...dto, enabled: false });

      expect(prisma.alertConfig.create).toHaveBeenCalledWith({
        data: { ...dto, enabled: false },
      });
      expect(created.enabled).toBe(false);
      await service.create(dto);
      expect(prisma.alertConfig.create).toHaveBeenLastCalledWith({
        data: { ...dto, enabled: undefined },
      });
    });

    it('maps a duplicate rule (P2002) to 409 naming it, and publishes nothing', async () => {
      prisma.alertConfig.create.mockRejectedValue(prismaError('P2002'));

      await expect(service.create(dto)).rejects.toThrow(
        new ConflictException(
          'An alert rule for gearboxTempC above at level error already exists',
        ),
      );
      expect(events.publish).not.toHaveBeenCalled();
    });

    it('still returns the stored rule when publishing fails (logged, not thrown)', async () => {
      prisma.alertConfig.create.mockResolvedValue(row());
      events.publish.mockRejectedValue(new Error('redis down'));
      const log = vi
        .spyOn(service['logger'], 'error')
        .mockImplementation(() => undefined);

      await expect(service.create(dto)).resolves.toMatchObject({ id: ID });
      expect(log).toHaveBeenCalledOnce();
    });
  });

  describe('update', () => {
    it('updates only the given fields, then publishes', async () => {
      prisma.alertConfig.update.mockResolvedValue(row({ valueMetric: 110 }));

      const updated = await service.update(ID, { valueMetric: 110 });

      expect(prisma.alertConfig.update).toHaveBeenCalledWith({
        where: { id: ID },
        data: { valueMetric: 110 },
      });
      expect(updated.valueMetric).toBe(110);
      expect(events.publish).toHaveBeenCalledWith(ALERT_CONFIG_CHANGED, {
        action: 'updated',
        id: ID,
        config: updated,
      });
    });

    it('disables a rule (enabled: false)', async () => {
      prisma.alertConfig.update.mockResolvedValue(row({ enabled: false }));

      const updated = await service.update(ID, { enabled: false });

      expect(prisma.alertConfig.update).toHaveBeenCalledWith({
        where: { id: ID },
        data: { enabled: false },
      });
      expect(updated.enabled).toBe(false);
    });

    it('rejects an empty change with 400 without touching the database', async () => {
      await expect(service.update(ID, {})).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.alertConfig.update).not.toHaveBeenCalled();
    });

    it('maps an unknown id (P2025) to 404', async () => {
      prisma.alertConfig.update.mockRejectedValue(prismaError('P2025'));

      await expect(service.update(ID, { valueMetric: 1 })).rejects.toThrow(
        new NotFoundException(`Alert config ${ID} not found`),
      );
      expect(events.publish).not.toHaveBeenCalled();
    });

    it('maps a change that duplicates another rule to 409 naming the merged rule', async () => {
      prisma.alertConfig.update.mockRejectedValue(prismaError('P2002'));
      prisma.alertConfig.findUnique.mockResolvedValue(row());

      await expect(service.update(ID, { alertLevel: 'warn' })).rejects.toThrow(
        'An alert rule for gearboxTempC above at level warn already exists',
      );
    });

    it('passes other Prisma errors on to the global filter', async () => {
      const error = prismaError('P9999');
      prisma.alertConfig.update.mockRejectedValue(error);

      await expect(service.update(ID, { valueMetric: 1 })).rejects.toBe(error);
    });
  });

  describe('remove', () => {
    it('deletes, then publishes the deletion', async () => {
      prisma.alertConfig.delete.mockResolvedValue(row());

      await service.remove(ID);

      expect(prisma.alertConfig.delete).toHaveBeenCalledWith({
        where: { id: ID },
      });
      expect(events.publish).toHaveBeenCalledWith(ALERT_CONFIG_CHANGED, {
        action: 'deleted',
        id: ID,
      });
    });

    it('maps a rule with alert history (P2003, RESTRICT) to 409 saying to disable it', async () => {
      prisma.alertConfig.delete.mockRejectedValue(prismaError('P2003'));

      await expect(service.remove(ID)).rejects.toThrow(
        new ConflictException(
          `Alert config ${ID} has alert history and cannot be deleted; disable it instead (enabled: false)`,
        ),
      );
      expect(events.publish).not.toHaveBeenCalled();
    });

    it('maps an unknown id (P2025) to 404', async () => {
      prisma.alertConfig.delete.mockRejectedValue(prismaError('P2025'));

      await expect(service.remove(ID)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(events.publish).not.toHaveBeenCalled();
    });
  });
});
