import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaService } from '@nextera/shared';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { FleetService } from './fleet.service.js';

const farm = (id: string, turbineIds: string[]) => ({
  id,
  name: `Farm ${id}`,
  latitude: new Prisma.Decimal('41.25'),
  longitude: new Prisma.Decimal('-96.53'),
  turbines: turbineIds.map((tid, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i}`, // internal UUID, never exposed
    turbineId: tid,
    farmId: id,
    latitude: new Prisma.Decimal('41.263'),
    longitude: new Prisma.Decimal('-96.518'),
    commissioned: i === 0,
  })),
});

const row = (turbineId: string, farmId: string) => ({
  id: 'r1',
  turbine_id: turbineId,
  farm_id: farmId,
  timestamp: new Date('2026-01-02T23:55:00Z'),
  received_at: new Date('2026-01-03T00:13:00Z'),
  created_at: new Date('2026-01-03T00:13:01Z'), // never in the response
  power_output_kw: 1960.5,
  wind_speed_ms: 6.7,
  rotor_rpm: 11.6,
  blade_pitch_deg: 4.6,
  gearbox_temp_c: 79.3,
});

describe('FleetService', () => {
  let service: FleetService;
  let prisma: DeepMockProxy<PrismaService>;

  beforeEach(async () => {
    prisma = mockDeep<PrismaService>();
    const moduleRef = await Test.createTestingModule({
      providers: [FleetService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = moduleRef.get(FleetService);
  });

  describe('overview', () => {
    it('attaches each turbine’s latest reading (mapped to camelCase) and null when none exists', async () => {
      prisma.farm.findMany.mockResolvedValue([
        farm('FARM01', ['TURB001', 'TURB003']),
        farm('FARM03', []),
      ] as never);
      prisma.$queryRaw.mockResolvedValue([row('TURB001', 'FARM01')]);
      const rule = {
        id: 'rule-1',
        measurementMetric: 'gearboxTempC',
        comparison: 'above',
        valueMetric: 70,
        alertLevel: 'warn',
        enabled: true,
      } as const;
      prisma.telemetryAlert.findMany.mockResolvedValue([
        { telemetryId: 'r1', alertId: 'rule-1', alert: rule },
      ] as never);

      const overview = await service.overview();

      // One query joins the triggered rules of every latest reading.
      expect(prisma.telemetryAlert.findMany).toHaveBeenCalledWith({
        where: { telemetryId: { in: ['r1'] } },
        include: { alert: true },
      });

      expect(overview).toEqual([
        {
          id: 'FARM01',
          name: 'Farm FARM01',
          latitude: 41.25,
          longitude: -96.53,
          turbines: [
            {
              id: 'TURB001',
              farmId: 'FARM01',
              latitude: 41.263,
              longitude: -96.518,
              commissioned: true,
              latest: {
                id: 'r1',
                turbineId: 'TURB001',
                farmId: 'FARM01',
                timestamp: '2026-01-02T23:55:00.000Z',
                receivedAt: '2026-01-03T00:13:00.000Z',
                powerOutputKw: 1960.5,
                windSpeedMs: 6.7,
                rotorRpm: 11.6,
                bladePitchDeg: 4.6,
                gearboxTempC: 79.3,
                alerts: [rule],
              },
            },
            expect.objectContaining({
              id: 'TURB003',
              commissioned: false,
              latest: null,
            }),
          ],
        },
        expect.objectContaining({ id: 'FARM03', turbines: [] }),
      ]);
    });

    it('orders turbines and joins their latest reading by the business key turbine_id', async () => {
      prisma.farm.findMany.mockResolvedValue([]);
      prisma.$queryRaw.mockResolvedValue([]);

      await service.overview();

      expect(prisma.farm.findMany).toHaveBeenCalledWith({
        orderBy: { id: 'asc' },
        include: { turbines: { orderBy: { turbineId: 'asc' } } },
      });
      const [strings] = prisma.$queryRaw.mock.calls[0] as unknown as [
        TemplateStringsArray,
      ];
      expect(strings.join('?').replace(/\s+/g, ' ')).toContain(
        'WHERE r.turbine_id = t.turbine_id',
      );
    });
  });

  describe('telemetry', () => {
    it('throws NotFoundException for an unknown turbine', async () => {
      prisma.turbine.findUnique.mockResolvedValue(null);

      await expect(
        service.telemetry('TURB999', { limit: 288 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.turbine.findUnique).toHaveBeenCalledWith({
        where: { turbineId: 'TURB999' },
        select: { turbineId: true },
      });
      expect(prisma.telemetry.findMany).not.toHaveBeenCalled();
    });

    it('queries [from, to) newest first with the limit', async () => {
      prisma.turbine.findUnique.mockResolvedValue({
        turbineId: 'TURB001',
      } as never);
      prisma.telemetry.findMany.mockResolvedValue([]);

      await service.telemetry('TURB001', {
        from: '2026-01-01T00:00:00Z',
        to: '2026-01-02T00:00:00Z',
        limit: 10,
      });

      expect(prisma.telemetry.findMany).toHaveBeenCalledWith({
        where: {
          turbineId: 'TURB001',
          timestamp: {
            gte: new Date('2026-01-01T00:00:00Z'),
            lt: new Date('2026-01-02T00:00:00Z'),
          },
        },
        orderBy: { timestamp: 'desc' },
        take: 10,
        include: { alerts: { include: { alert: true } } }, // the triggered rules
      });
    });

    it('returns each reading with its triggered rules, worst level first', async () => {
      prisma.turbine.findUnique.mockResolvedValue({
        turbineId: 'TURB001',
      } as never);
      const alert = (id: string, alertLevel: 'info' | 'error') => ({
        alert: {
          id,
          measurementMetric: 'gearboxTempC',
          comparison: 'above',
          valueMetric: 1,
          alertLevel,
          enabled: true,
        },
      });
      prisma.telemetry.findMany.mockResolvedValue([
        {
          id: 'r1',
          turbineId: 'TURB001',
          farmId: 'FARM01',
          timestamp: new Date('2026-01-02T23:55:00Z'),
          receivedAt: new Date('2026-01-02T23:56:00Z'),
          powerOutputKw: 1,
          windSpeedMs: 1,
          rotorRpm: 1,
          bladePitchDeg: 1,
          gearboxTempC: 126.5,
          alerts: [alert('i', 'info'), alert('e', 'error')],
        },
      ] as never);

      const [reading] = await service.telemetry('TURB001', { limit: 10 });

      expect(reading.alerts.map((a) => a.id)).toEqual(['e', 'i']);
    });

    it('omits time bounds that are not given', async () => {
      prisma.turbine.findUnique.mockResolvedValue({
        turbineId: 'TURB001',
      } as never);
      prisma.telemetry.findMany.mockResolvedValue([]);

      await service.telemetry('TURB001', { limit: 288 });

      expect(prisma.telemetry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { turbineId: 'TURB001', timestamp: {} },
        }),
      );
    });
  });

  describe('telemetryStats', () => {
    /** The SQL text and bound values of the stats query (a tagged-template call). */
    const query = () => {
      const [strings, ...values] = prisma.$queryRaw.mock
        .calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
      const sql = Prisma.sql(strings, ...values);
      return { text: sql.sql.replace(/\s+/g, ' '), values: sql.values };
    };

    it('throws NotFoundException for an unknown turbine without querying', async () => {
      prisma.turbine.findUnique.mockResolvedValue(null);

      await expect(
        service.telemetryStats('TURB999', { limit: 288 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('aggregates the newest `limit` readings in [from, to) in one query', async () => {
      prisma.turbine.findUnique.mockResolvedValue({
        turbineId: 'TURB002',
      } as never);
      prisma.$queryRaw.mockResolvedValue([
        {
          count: 2,
          first_timestamp: new Date('2026-01-02T03:20:00Z'),
          last_timestamp: new Date('2026-01-02T03:25:00Z'),
          power_output_kw_median: 2150,
          power_output_kw_high: 2200,
          power_output_kw_low: 2100,
          wind_speed_ms_median: 8,
          wind_speed_ms_high: 8.5,
          wind_speed_ms_low: 7.5,
          rotor_rpm_median: 13,
          rotor_rpm_high: 13,
          rotor_rpm_low: 13,
          blade_pitch_deg_median: 4,
          blade_pitch_deg_high: 4,
          blade_pitch_deg_low: 4,
          gearbox_temp_c_median: 126.5,
          gearbox_temp_c_high: 126.5,
          gearbox_temp_c_low: 126.5,
        },
      ]);

      const stats = await service.telemetryStats('TURB002', {
        from: '2026-01-02T03:20:00Z',
        to: '2026-01-02T03:30:00Z',
        limit: 10,
      });

      expect(stats).toEqual({
        turbineId: 'TURB002',
        from: '2026-01-02T03:20:00.000Z',
        to: '2026-01-02T03:25:00.000Z',
        count: 2,
        metrics: {
          powerOutputKw: { median: 2150, high: 2200, low: 2100 },
          windSpeedMs: { median: 8, high: 8.5, low: 7.5 },
          rotorRpm: { median: 13, high: 13, low: 13 },
          bladePitchDeg: { median: 4, high: 4, low: 4 },
          gearboxTempC: { median: 126.5, high: 126.5, low: 126.5 },
        },
      });
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const { text, values } = query();
      // Same row set as telemetry(): the window, newest first, limited, then aggregated.
      expect(text).toContain(
        'WHERE r.turbine_id = ? AND r.timestamp >= ? AND r.timestamp < ? ORDER BY r.timestamp DESC LIMIT ?',
      );
      expect(values).toEqual([
        'TURB002',
        new Date('2026-01-02T03:20:00Z'),
        new Date('2026-01-02T03:30:00Z'),
        10,
      ]);
      for (const column of [
        'power_output_kw',
        'wind_speed_ms',
        'rotor_rpm',
        'blade_pitch_deg',
        'gearbox_temp_c',
      ]) {
        expect(text).toContain(
          `percentile_cont(0.5) WITHIN GROUP (ORDER BY w.${column}) AS ${column}_median`,
        );
        expect(text).toContain(`max(w.${column}) AS ${column}_high`);
        expect(text).toContain(`min(w.${column}) AS ${column}_low`);
      }
      expect(text).toContain('count(*)::int AS count');
    });

    it('omits time bounds that are not given', async () => {
      prisma.turbine.findUnique.mockResolvedValue({
        turbineId: 'TURB001',
      } as never);
      prisma.$queryRaw.mockResolvedValue([
        { count: 0, first_timestamp: null, last_timestamp: null },
      ]);

      const stats = await service.telemetryStats('TURB001', { limit: 288 });

      const { text, values } = query();
      expect(text).toContain(
        'WHERE r.turbine_id = ? ORDER BY r.timestamp DESC LIMIT ?',
      );
      expect(values).toEqual(['TURB001', 288]);
      expect(stats).toMatchObject({
        count: 0,
        from: null,
        to: null,
        metrics: { powerOutputKw: null, gearboxTempC: null },
      });
    });
  });
});
