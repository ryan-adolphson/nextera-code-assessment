import { BadRequestException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '@nextera/shared';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { AnomaliesService } from './anomalies.service.js';

const row = (over: object = {}) => ({
  kind: 'low_power_in_wind',
  metric: null,
  turbine_id: 'TURB001',
  farm_id: 'FARM01',
  episode_start: new Date('2026-01-01T13:40:00Z'),
  episode_end: new Date('2026-01-01T13:50:00Z'),
  readings: 3,
  value: null,
  wind_speed_ms: '15.8',
  lost_kwh: '875',
  ...over,
});

describe('AnomaliesService', () => {
  let service: AnomaliesService;
  let prisma: DeepMockProxy<PrismaService>;

  beforeEach(async () => {
    prisma = mockDeep<PrismaService>();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AnomaliesService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = moduleRef.get(AnomaliesService);
  });

  it('maps the query rows to the response', async () => {
    prisma.$queryRaw.mockResolvedValue([row()] as never);

    const result = await service.list({
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-02T00:00:00Z',
    });

    expect(result).toEqual({
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-02T00:00:00.000Z',
      estimatedLostKwh: 875,
      anomalies: [
        {
          turbineId: 'TURB001',
          farmId: 'FARM01',
          kind: 'low_power_in_wind',
          metric: null,
          start: '2026-01-01T13:40:00.000Z',
          end: '2026-01-01T13:50:00.000Z',
          readings: 3,
          value: null,
          windSpeedMs: 15.8,
          estimatedLostKwh: 875,
        },
      ],
    });
  });

  it.each([
    ['to equal to from', '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z'],
    ['to before from', '2026-01-03T00:00:00Z', '2026-01-02T00:00:00Z'],
    ['more than 31 days', '2026-01-01T00:00:00Z', '2026-02-01T00:00:01Z'],
  ])('rejects %s with 400 without querying', async (_, from, to) => {
    await expect(service.list({ from, to })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('leaves database failures to the global filters', async () => {
    prisma.$queryRaw.mockRejectedValue(new Error('boom'));
    await expect(
      service.list({
        from: '2026-01-01T00:00:00Z',
        to: '2026-01-02T00:00:00Z',
      }),
    ).rejects.toThrow('boom');
  });
});
