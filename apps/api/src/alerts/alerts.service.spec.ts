import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '@nextera/shared';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { AlertsService } from './alerts.service.js';

const rule = (id: string, alertLevel: 'info' | 'warn' | 'error') => ({
  id,
  measurementMetric: 'gearboxTempC',
  comparison: 'above',
  valueMetric: 1,
  alertLevel,
  enabled: true,
});

const reading = (id: string, turbineId: string, alerts: unknown[]) => ({
  id,
  turbineId,
  farmId: 'FARM01',
  timestamp: new Date('2026-01-02T03:25:00Z'),
  receivedAt: new Date('2026-01-02T03:26:00Z'),
  createdAt: new Date('2026-01-02T03:26:01Z'),
  powerOutputKw: 1,
  windSpeedMs: 1,
  rotorRpm: 1,
  bladePitchDeg: 1,
  gearboxTempC: 126.5,
  alerts,
});

describe('AlertsService', () => {
  let service: AlertsService;
  let prisma: DeepMockProxy<PrismaService>;

  beforeEach(async () => {
    prisma = mockDeep<PrismaService>();
    const moduleRef = await Test.createTestingModule({
      providers: [AlertsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(AlertsService);
  });

  it('queries flagged readings in [from, to), grouped by turbine, newest first, with their rules', async () => {
    prisma.telemetry.findMany.mockResolvedValue([]);

    await service.list({
      from: '2026-01-02T00:00:00Z',
      to: '2026-01-03T00:00:00Z',
    });

    expect(prisma.telemetry.findMany).toHaveBeenCalledWith({
      where: {
        timestamp: {
          gte: new Date('2026-01-02T00:00:00Z'),
          lt: new Date('2026-01-03T00:00:00Z'),
        },
        alerts: { some: {} }, // only readings that triggered something
      },
      orderBy: [{ turbineId: 'asc' }, { timestamp: 'desc' }],
      include: { alerts: { include: { alert: true } } },
    });
  });

  it('maps each reading with its rules worst level first, without internal columns', async () => {
    prisma.telemetry.findMany.mockResolvedValue([
      reading('r1', 'TURB002', [
        { alert: rule('w', 'warn') },
        { alert: rule('e', 'error') },
      ]),
    ] as never);

    const [first] = await service.list({
      from: '2026-01-02T00:00:00Z',
      to: '2026-01-03T00:00:00Z',
    });

    expect(first.turbineId).toBe('TURB002');
    expect(first.alerts.map((a) => a.id)).toEqual(['e', 'w']);
    expect(first).not.toHaveProperty('createdAt');
  });

  it.each([
    [
      'to equal to from',
      '2026-01-02T00:00:00Z',
      '2026-01-02T00:00:00Z',
      'to must be after from',
    ],
    [
      'to before from',
      '2026-01-03T00:00:00Z',
      '2026-01-02T00:00:00Z',
      'to must be after from',
    ],
    [
      'more than 31 days',
      '2026-01-01T00:00:00Z',
      '2026-02-01T00:00:01Z',
      'The range may span at most 31 days',
    ],
  ])('rejects %s with 400 without querying', async (_, from, to, message) => {
    await expect(service.list({ from, to })).rejects.toThrow(
      new BadRequestException(message),
    );
    expect(prisma.telemetry.findMany).not.toHaveBeenCalled();
  });

  it('accepts exactly 31 days', async () => {
    prisma.telemetry.findMany.mockResolvedValue([]);
    await expect(
      service.list({
        from: '2026-01-01T00:00:00Z',
        to: '2026-02-01T00:00:00Z',
      }),
    ).resolves.toEqual([]);
  });
});
