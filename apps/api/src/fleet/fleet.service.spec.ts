import { BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  EventStore,
  FLEET_CHANGED,
  Prisma,
  PrismaService,
} from '@nextera/shared';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { FleetService } from './fleet.service.js';
import { WeatherQueryDto } from './dto/weather-query.dto.js';
import { FarmDailyQueryDto } from './dto/farm-daily-query.dto.js';

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
  let events: DeepMockProxy<EventStore>;

  beforeEach(async () => {
    prisma = mockDeep<PrismaService>();
    events = mockDeep<EventStore>();
    const moduleRef = await Test.createTestingModule({
      providers: [
        FleetService,
        { provide: PrismaService, useValue: prisma },
        { provide: EventStore, useValue: events },
      ],
    }).compile();
    service = moduleRef.get(FleetService);
  });

  describe('setCommissioned', () => {
    const turbine = (commissioned: boolean) => ({
      id: '00000000-0000-4000-8000-000000000001', // internal UUID, never exposed
      turbineId: 'TURB001',
      farmId: 'FARM01',
      latitude: new Prisma.Decimal('41.263'),
      longitude: new Prisma.Decimal('-96.518'),
      commissioned,
    });
    const response = (commissioned: boolean) => ({
      id: 'TURB001',
      farmId: 'FARM01',
      latitude: 41.263,
      longitude: -96.518,
      commissioned,
    });

    it('updates only a row whose value differs, returns the turbine and publishes fleet.changed', async () => {
      prisma.turbine.updateManyAndReturn.mockResolvedValue([
        turbine(true),
      ] as never);

      await expect(service.setCommissioned('TURB001', true)).resolves.toEqual(
        response(true),
      );

      expect(prisma.turbine.updateManyAndReturn).toHaveBeenCalledWith({
        where: { turbineId: 'TURB001', commissioned: { not: true } },
        data: { commissioned: true },
      });
      expect(prisma.turbine.findUnique).not.toHaveBeenCalled();
      expect(events.publish).toHaveBeenCalledTimes(1);
      expect(events.publish).toHaveBeenCalledWith(FLEET_CHANGED, {
        turbineId: 'TURB001',
      });
    });

    it('un-commissions a turbine the same way', async () => {
      prisma.turbine.updateManyAndReturn.mockResolvedValue([
        turbine(false),
      ] as never);

      await expect(service.setCommissioned('TURB001', false)).resolves.toEqual(
        response(false),
      );

      expect(prisma.turbine.updateManyAndReturn).toHaveBeenCalledWith({
        where: { turbineId: 'TURB001', commissioned: { not: false } },
        data: { commissioned: false },
      });
    });

    it('answers an unknown turbine with 404 and no event', async () => {
      prisma.turbine.updateManyAndReturn.mockResolvedValue([] as never);
      prisma.turbine.findUnique.mockResolvedValue(null);

      const error = await service
        .setCommissioned('TURB404', true)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as NotFoundException).message).toBe(
        'Turbine TURB404 not found',
      );
      expect(events.publish).not.toHaveBeenCalled();
    });

    it('returns the turbine without an event when the value is already set', async () => {
      prisma.turbine.updateManyAndReturn.mockResolvedValue([] as never);
      prisma.turbine.findUnique.mockResolvedValue(turbine(true) as never);

      await expect(service.setCommissioned('TURB001', true)).resolves.toEqual(
        response(true),
      );

      expect(events.publish).not.toHaveBeenCalled();
    });

    it('publishes only after the write has committed', async () => {
      let commit!: (rows: unknown) => void;
      prisma.turbine.updateManyAndReturn.mockReturnValue(
        new Promise((resolve) => {
          commit = resolve;
        }) as never,
      );

      const result = service.setCommissioned('TURB001', true);
      await new Promise((resolve) => setImmediate(resolve));
      expect(events.publish).not.toHaveBeenCalled();

      commit([turbine(true)]);
      await result;
      expect(events.publish).toHaveBeenCalledTimes(1);
    });

    it('does not publish when the write fails, and lets the error reach the global filter', async () => {
      const failure = new Error('database down');
      prisma.turbine.updateManyAndReturn.mockRejectedValue(failure);

      await expect(service.setCommissioned('TURB001', true)).rejects.toBe(
        failure,
      );

      expect(events.publish).not.toHaveBeenCalled();
    });

    it('still returns 200 when Redis fails after the commit', async () => {
      prisma.turbine.updateManyAndReturn.mockResolvedValue([
        turbine(true),
      ] as never);
      events.publish.mockRejectedValue(new Error('redis down'));
      vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);

      await expect(service.setCommissioned('TURB001', true)).resolves.toEqual(
        response(true),
      );

      expect(Logger.prototype.error).toHaveBeenCalledOnce();
    });
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

  describe('weather', () => {
    const DAY = { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' };
    const query = (
      interval: '30min' | 'daily',
      timeZone = 'UTC',
    ): WeatherQueryDto =>
      Object.assign(new WeatherQueryDto(), { ...DAY, interval, timeZone });

    it('throws NotFoundException for an unknown farm', async () => {
      prisma.farm.findUnique.mockResolvedValue(null);
      await expect(service.weather('FARM99', query('30min'))).rejects.toThrow(
        new NotFoundException('Farm FARM99 not found'),
      );
      expect(prisma.farmWeather.findMany).not.toHaveBeenCalled();
    });

    it('throws BadRequestException for a range over 31 days', async () => {
      prisma.farm.findUnique.mockResolvedValue({ id: 'FARM01' } as never);
      await expect(
        service.weather('FARM01', {
          ...query('daily'),
          to: '2026-03-01T00:00:00Z',
        }),
      ).rejects.toThrow(
        new BadRequestException('The range may span at most 31 days'),
      );
    });

    it('throws BadRequestException for a time zone Postgres does not know', async () => {
      prisma.farm.findUnique.mockResolvedValue({ id: 'FARM01' } as never);
      prisma.$queryRaw.mockResolvedValue([{ known: false }]);
      await expect(
        service.weather('FARM01', query('daily', 'Mars/Olympus')),
      ).rejects.toThrow(
        new BadRequestException(
          'timeZone must be an IANA time zone name, e.g. "America/Chicago" (default "UTC")',
        ),
      );
    });

    it('returns the 30-minute buckets in [from, to), oldest first, without internal fields', async () => {
      prisma.farm.findUnique.mockResolvedValue({ id: 'FARM01' } as never);
      prisma.farmWeather.findMany.mockResolvedValue([
        {
          farmId: 'FARM01',
          time: new Date('2026-01-01T00:30:00Z'),
          samples: 2,
          windSpeed10mMs: 5.03,
          windSpeed80mMs: 10.78,
          windDirection10mDeg: 323,
          windDirection80mDeg: 330,
          windGusts10mMs: 7.4,
          temperature2mC: 5.9,
          relativeHumidity2mPct: 51,
          surfacePressureHpa: 969.3,
          precipitationMm: null,
          cloudCoverPct: 0,
          fetchedAt: new Date(),
        },
      ]);

      const result = await service.weather('FARM01', query('30min'));

      expect(prisma.farmWeather.findMany).toHaveBeenCalledWith({
        where: {
          farmId: 'FARM01',
          time: { gte: new Date(DAY.from), lt: new Date(DAY.to) },
        },
        orderBy: { time: 'asc' },
      });
      expect(result).toEqual({
        farmId: 'FARM01',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-02T00:00:00.000Z',
        interval: '30min',
        timeZone: 'UTC',
        points: [
          {
            time: '2026-01-01T00:30:00.000Z',
            samples: 2,
            windSpeed10mMs: 5.03,
            windSpeed80mMs: 10.78,
            windDirection10mDeg: 323,
            windDirection80mDeg: 330,
            windGusts10mMs: 7.4,
            temperature2mC: 5.9,
            relativeHumidity2mPct: 51,
            surfacePressureHpa: 969.3,
            precipitationMm: null,
            cloudCoverPct: 0,
          },
        ],
      });
    });

    it('aggregates daily in one Postgres query over the UTC day by default', async () => {
      prisma.farm.findUnique.mockResolvedValue({ id: 'FARM01' } as never);
      prisma.$queryRaw.mockResolvedValue([]);

      await service.weather('FARM01', query('daily'));

      // UTC needs no zone lookup: the one query is the aggregate.
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const [strings, ...values] = prisma.$queryRaw.mock
        .calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
      const sql = Prisma.sql(strings, ...values);
      const text = sql.sql.replace(/\s+/g, ' ');
      expect(text).toContain(
        "to_char(w.time AT TIME ZONE ?::text, 'YYYY-MM-DD') AS day",
      );
      expect(text).toContain('count(*)::int AS samples');
      expect(text).toContain('avg(sin(radians(w.wind_direction_80m_deg)))');
      expect(text).toContain('sum(w.precipitation_mm) AS precipitation_sum');
      expect(text).toContain('FROM farm_weather w');
      expect(sql.values).toEqual([
        'UTC',
        'FARM01',
        new Date(DAY.from),
        new Date(DAY.to),
      ]);
    });

    it("returns a turbine's farm weather with its id, 404 for an unknown turbine", async () => {
      prisma.turbine.findUnique.mockResolvedValueOnce(null);
      await expect(
        service.turbineWeather('TURB999', query('30min')),
      ).rejects.toThrow(new NotFoundException('Turbine TURB999 not found'));

      prisma.turbine.findUnique.mockResolvedValueOnce({
        farmId: 'FARM02',
      } as never);
      prisma.farmWeather.findMany.mockResolvedValue([]);
      await expect(
        service.turbineWeather('TURB002', query('30min')),
      ).resolves.toEqual({
        farmId: 'FARM02',
        turbineId: 'TURB002',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-02T00:00:00.000Z',
        interval: '30min',
        timeZone: 'UTC',
        points: [],
      });
    });
  });

  describe('dailyHistory', () => {
    const RANGE = { from: '2026-01-01T06:00:00Z', to: '2026-01-03T06:00:00Z' };
    const query = (overrides: Partial<FarmDailyQueryDto> = {}) =>
      Object.assign(new FarmDailyQueryDto(), {
        ...RANGE,
        timeZone: 'UTC',
        ...overrides,
      });
    const farmRow = { id: 'FARM01', _count: { turbines: 3 } };
    const ohlc = (prefix: string, base: number) => ({
      [`${prefix}_open`]: base,
      [`${prefix}_close`]: base + 1,
      [`${prefix}_high`]: base + 2.005,
      [`${prefix}_low`]: base - 1.123456,
    });
    const dayRow = (day: string, computedAt: string) => ({
      day,
      turbines: 2,
      readings: BigInt(576),
      computed_at: new Date(computedAt),
      ...ohlc('power', 4000),
      ...ohlc('wind_speed', 9),
      ...ohlc('rotor_rpm', 14),
      ...ohlc('blade_pitch', 3),
      ...ohlc('gearbox_temp', 80),
    });

    it('throws NotFoundException for an unknown farm before reading rollups', async () => {
      prisma.farm.findUnique.mockResolvedValue(null);
      await expect(service.dailyHistory('FARM99', query())).rejects.toThrow(
        new NotFoundException('Farm FARM99 not found'),
      );
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it.each([
      ['a reversed range', { to: RANGE.from }, 'to must be after from'],
      [
        'an empty range',
        { to: RANGE.from, from: RANGE.from },
        'to must be after from',
      ],
      [
        'more than 183 days (+1 h for DST)',
        { from: '2026-01-01T00:00:00Z', to: '2026-07-03T01:00:01Z' },
        'The range may span at most 183 days',
      ],
    ])('throws BadRequestException for %s', async (_, overrides, message) => {
      prisma.farm.findUnique.mockResolvedValue(farmRow as never);
      await expect(
        service.dailyHistory('FARM01', query(overrides)),
      ).rejects.toThrow(new BadRequestException(message));
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('accepts 183 local days that are an hour longer across a DST change', async () => {
      prisma.farm.findUnique.mockResolvedValue(farmRow as never);
      prisma.$queryRaw.mockResolvedValue([]);
      // Chicago: 2026-07-01 00:00 CDT (05:00Z) to 2026-12-31 00:00 CST (06:00Z) = 183 days + 1 h.
      await expect(
        service.dailyHistory(
          'FARM01',
          query({ from: '2026-07-01T05:00:00Z', to: '2026-12-31T06:00:00Z' }),
        ),
      ).resolves.toMatchObject({ days: [] });
    });

    it('throws BadRequestException for a time zone Postgres does not know', async () => {
      prisma.farm.findUnique.mockResolvedValue(farmRow as never);
      prisma.$queryRaw.mockResolvedValue([{ known: false }]);
      await expect(
        service.dailyHistory('FARM01', query({ timeZone: 'Mars/Olympus' })),
      ).rejects.toThrow(
        new BadRequestException(
          'timeZone must be an IANA time zone name, e.g. "America/Chicago" (default "UTC")',
        ),
      );
    });

    it('aggregates the rollups by local day in one query and maps the days', async () => {
      prisma.farm.findUnique.mockResolvedValue(farmRow as never);
      prisma.$queryRaw.mockResolvedValue([
        dayRow('2026-01-01', '2026-01-03T00:15:00Z'),
        dayRow('2026-01-02', '2026-01-03T00:30:00Z'),
      ]);

      const result = await service.dailyHistory('FARM01', query());

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const [strings, ...values] = prisma.$queryRaw.mock
        .calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
      const sql = Prisma.sql(strings, ...values);
      const text = sql.sql.replace(/\s+/g, ' ');
      expect(text).toContain(
        "to_char(r.bucket_start AT TIME ZONE ?::text, 'YYYY-MM-DD') AS day",
      );
      expect(text).toContain(
        '(array_agg(r.power_open ORDER BY r.bucket_start))[1] AS power_open',
      );
      expect(text).toContain(
        '(array_agg(r.power_close ORDER BY r.bucket_start DESC))[1] AS power_close',
      );
      expect(text).toContain('max(r.gearbox_temp_high) AS gearbox_temp_high');
      expect(text).toContain('FROM farm_telemetry_rollups r');
      expect(sql.values).toEqual([
        'UTC',
        'FARM01',
        new Date(RANGE.from),
        new Date(RANGE.to),
      ]);
      expect(result).toEqual({
        farmId: 'FARM01',
        from: '2026-01-01T06:00:00.000Z',
        to: '2026-01-03T06:00:00.000Z',
        timeZone: 'UTC',
        turbineCount: 3,
        computedAt: '2026-01-03T00:30:00.000Z',
        days: [
          expect.objectContaining({ date: '2026-01-01' }),
          {
            date: '2026-01-02',
            turbines: 2,
            readings: 576,
            powerOutputKw: {
              open: 4000,
              close: 4001,
              high: 4002.01,
              low: 3998.88,
            },
            windSpeedMs: { open: 9, close: 10, high: 11.01, low: 7.88 },
            rotorRpm: { open: 14, close: 15, high: 16.01, low: 12.88 },
            bladePitchDeg: { open: 3, close: 4, high: 5.01, low: 1.88 },
            gearboxTempC: { open: 80, close: 81, high: 82.01, low: 78.88 },
          },
        ],
      });
    });

    it('answers an empty range with no days and computedAt null', async () => {
      prisma.farm.findUnique.mockResolvedValue(farmRow as never);
      prisma.$queryRaw.mockResolvedValue([]);
      await expect(service.dailyHistory('FARM01', query())).resolves.toEqual(
        expect.objectContaining({
          computedAt: null,
          days: [],
          turbineCount: 3,
        }),
      );
    });
  });
});
