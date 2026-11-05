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

  const RANGE = { from: '2026-01-02T00:00:00Z', to: '2026-01-03T00:00:00Z' };
  const key = (id: string) => ({
    telemetry_id: id,
    reading_timestamp: new Date('2026-01-02T03:25:00Z'),
  });
  const row = (id: string, turbineId: string) => ({
    id,
    turbine_id: turbineId,
    farm_id: 'FARM01',
    timestamp: new Date('2026-01-02T03:25:00Z'),
    received_at: new Date('2026-01-02T03:26:00Z'),
    created_at: new Date('2026-01-02T03:26:01Z'),
    power_output_kw: 1,
    wind_speed_ms: 1,
    rotor_rpm: 1,
    blade_pitch_deg: 1,
    gearbox_temp_c: 126.5,
  });

  it('pages the flagged readings newest first and maps them with their rules, worst level first', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([key('r1')]) // telemetry_alerts keys
      .mockResolvedValueOnce([row('r1', 'TURB002')]) // the readings
      .mockResolvedValueOnce([
        { telemetry_id: 'r1', alert_id: 'w' },
        { telemetry_id: 'r1', alert_id: 'e' },
      ]); // their rule links
    prisma.alertConfig.findMany.mockResolvedValue([
      rule('w', 'warn'),
      rule('e', 'error'),
    ] as never);

    const page = await service.list({ ...RANGE, limit: 500 });

    expect(page.nextCursor).toBeNull();
    const [first] = page.items;
    expect(first.turbineId).toBe('TURB002');
    expect(first.alerts.map((a) => a.id)).toEqual(['e', 'w']);
    expect(first).not.toHaveProperty('createdAt');
  });

  it('returns a nextCursor when there are more flagged readings than the limit', async () => {
    prisma.$queryRaw
      .mockResolvedValueOnce([key('r1'), key('r2')]) // limit 1 + 1
      .mockResolvedValueOnce([row('r1', 'TURB001')])
      .mockResolvedValueOnce([]);

    const page = await service.list({ ...RANGE, limit: 1 });

    expect(page.items).toHaveLength(1);
    expect(page.nextCursor).toEqual(expect.any(String));
  });

  it('rejects a bad cursor with 400 without querying', async () => {
    await expect(
      service.list({ ...RANGE, limit: 500, cursor: 'junk' }),
    ).rejects.toThrow(new BadRequestException('Invalid cursor'));
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
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
    await expect(service.list({ from, to, limit: 500 })).rejects.toThrow(
      new BadRequestException(message),
    );
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('accepts exactly 31 days', async () => {
    prisma.$queryRaw.mockResolvedValue([]);
    await expect(
      service.list({
        from: '2026-01-01T00:00:00Z',
        to: '2026-02-01T00:00:00Z',
        limit: 500,
      }),
    ).resolves.toEqual({ items: [], nextCursor: null });
  });
});
