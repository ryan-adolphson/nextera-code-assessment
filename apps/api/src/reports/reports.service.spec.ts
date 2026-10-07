import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '@nextera/shared';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { ReportsService } from './reports.service.js';

const RANGE = { from: '2026-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' };

const reading = (id: string, alerts: unknown[] = []) => ({
  id,
  turbineId: 'TURB002',
  farmId: 'FARM02',
  timestamp: new Date('2026-01-02T03:25:00Z'),
  receivedAt: new Date('2026-01-02T03:26:00Z'),
  createdAt: new Date('2026-01-02T03:26:01Z'),
  powerOutputKw: 2200,
  windSpeedMs: 8.5,
  rotorRpm: 13,
  bladePitchDeg: 4,
  gearboxTempC: 126.5,
  alerts,
});

describe('ReportsService', () => {
  let service: ReportsService;
  let prisma: DeepMockProxy<PrismaService>;

  beforeEach(async () => {
    prisma = mockDeep<PrismaService>();
    prisma.farm.findUnique.mockResolvedValue({
      id: 'FARM02',
      name: 'High Plains',
    } as never);
    prisma.turbine.findUnique.mockResolvedValue({
      turbineId: 'TURB002',
      farmId: 'FARM02',
      farm: { name: 'High Plains' },
    } as never);
    prisma.telemetry.findMany.mockResolvedValue([]);
    const moduleRef = await Test.createTestingModule({
      providers: [ReportsService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(ReportsService);
  });

  it('reports a farm: all its readings in [from, to), by turbine then time, with their rules', async () => {
    const report = await service.telemetry({ farmId: 'FARM02', ...RANGE });

    expect(prisma.telemetry.findMany).toHaveBeenCalledWith({
      where: {
        farmId: 'FARM02',
        timestamp: {
          gte: new Date('2026-01-01T00:00:00Z'),
          lt: new Date('2026-01-03T00:00:00Z'),
        },
      },
      orderBy: [{ turbineId: 'asc' }, { timestamp: 'asc' }],
      include: { alerts: { include: { alert: true } } },
    });
    expect(report).toEqual({
      scope: {
        kind: 'farm',
        id: 'FARM02',
        name: 'High Plains',
        farmId: 'FARM02',
      },
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-03T00:00:00.000Z',
      readings: [],
    });
  });

  it('reports a turbine by its business key, mapping readings with their alerts', async () => {
    prisma.telemetry.findMany.mockResolvedValue([
      reading('r1', [
        {
          alert: {
            id: 'rule',
            measurementMetric: 'gearboxTempC',
            comparison: 'above',
            valueMetric: 120,
            alertLevel: 'error',
            enabled: true,
          },
        },
      ]),
    ] as never);

    const report = await service.telemetry({ turbineId: 'TURB002', ...RANGE });

    expect(prisma.turbine.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { turbineId: 'TURB002' } }),
    );
    expect(prisma.telemetry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ turbineId: 'TURB002' }),
      }),
    );
    expect(report.scope).toEqual({
      kind: 'turbine',
      id: 'TURB002',
      name: 'High Plains',
      farmId: 'FARM02',
    });
    expect(report.readings[0]).toMatchObject({
      id: 'r1',
      timestamp: '2026-01-02T03:25:00.000Z',
      alerts: [{ id: 'rule', alertLevel: 'error' }],
    });
    expect(report.readings[0]).not.toHaveProperty('createdAt');
  });

  it.each([
    ['neither scope', {}],
    ['both scopes', { farmId: 'FARM02', turbineId: 'TURB002' }],
  ])('rejects %s with 400 without querying', async (_, scope) => {
    await expect(service.telemetry({ ...scope, ...RANGE })).rejects.toThrow(
      new BadRequestException('Provide exactly one of farmId or turbineId'),
    );
    expect(prisma.telemetry.findMany).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown farm or turbine', async () => {
    prisma.farm.findUnique.mockResolvedValue(null);
    prisma.turbine.findUnique.mockResolvedValue(null);
    await expect(
      service.telemetry({ farmId: 'FARM99', ...RANGE }),
    ).rejects.toThrow(new NotFoundException('Farm FARM99 not found'));
    await expect(
      service.telemetry({ turbineId: 'TURB999', ...RANGE }),
    ).rejects.toThrow(new NotFoundException('Turbine TURB999 not found'));
  });

  it('rejects a range over 31 days (400)', async () => {
    await expect(
      service.telemetry({
        farmId: 'FARM02',
        from: '2026-01-01T00:00:00Z',
        to: '2026-02-02T00:00:00Z',
      }),
    ).rejects.toThrow(
      new BadRequestException('The range may span at most 31 days'),
    );
    expect(prisma.telemetry.findMany).not.toHaveBeenCalled();
  });
});
