import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import {
  ALERT_RULE_ORDER,
  QueryError,
  QueryInputError,
  QueryNotFoundError,
  alertsInRange,
  getTurbine,
  listAlertRules,
  parseRange,
  reportSummary,
  reportTelemetry,
  telemetryStats,
  turbineTelemetry,
} from './queries.js';

const RANGE = { from: '2026-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' };

const rule = (id: string, alertLevel: 'info' | 'warn' | 'error') => ({
  id,
  measurementMetric: 'gearboxTempC' as const,
  comparison: 'above' as const,
  valueMetric: 120,
  alertLevel,
  enabled: alertLevel !== 'info',
});

const reading = (alerts: { alert: ReturnType<typeof rule> }[] = []) => ({
  id: 'r1',
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

/** SQL text (whitespace collapsed) and bound values of the n-th $queryRaw call. */
function rawQuery(prisma: DeepMockProxy<PrismaClient>, n = 0) {
  const [strings, ...values] = prisma.$queryRaw.mock.calls[n] as unknown as [
    TemplateStringsArray,
    ...unknown[],
  ];
  const sql = Prisma.sql(strings, ...values);
  return { text: sql.sql.replace(/\s+/g, ' '), values: sql.values };
}

describe('parseRange', () => {
  it('returns the parsed bounds of a forward range within the limit', () => {
    expect(parseRange('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')).toEqual({
      start: new Date('2026-01-01T00:00:00Z'),
      end: new Date('2026-02-01T00:00:00Z'),
    });
  });

  it.each([
    [
      'equal bounds',
      '2026-01-02T00:00:00Z',
      '2026-01-02T00:00:00Z',
      31,
      'to must be after from',
    ],
    [
      'a reversed range',
      '2026-01-03T00:00:00Z',
      '2026-01-02T00:00:00Z',
      31,
      'to must be after from',
    ],
    [
      'a range over 31 days',
      '2026-01-01T00:00:00Z',
      '2026-02-01T00:00:01Z',
      31,
      'The range may span at most 31 days',
    ],
    [
      'a range over a custom limit',
      '2026-01-01T00:00:00Z',
      '2026-01-03T00:00:00Z',
      1,
      'The range may span at most 1 days',
    ],
  ])('rejects %s with a QueryInputError', (_, from, to, maxDays, message) => {
    expect(() => parseRange(from, to, maxDays)).toThrow(
      new QueryInputError(message),
    );
  });

  it('is a QueryError (never an HTTP type)', () => {
    expect(new QueryInputError('x')).toBeInstanceOf(QueryError);
    expect(new QueryNotFoundError('x')).toBeInstanceOf(QueryError);
  });
});

describe('read queries', () => {
  let prisma: DeepMockProxy<PrismaClient>;

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
  });

  describe('turbineTelemetry / telemetryStats', () => {
    it.each([
      [
        'turbineTelemetry',
        () => turbineTelemetry(prisma, 'TURB999', { limit: 288 }),
      ],
      [
        'telemetryStats',
        () => telemetryStats(prisma, 'TURB999', { limit: 288 }),
      ],
    ])(
      '%s throws QueryNotFoundError for an unknown turbine without querying',
      async (_, run) => {
        prisma.turbine.findUnique.mockResolvedValue(null);

        await expect(run()).rejects.toThrow(
          new QueryNotFoundError('Turbine TURB999 not found'),
        );
        expect(prisma.telemetry.findMany).not.toHaveBeenCalled();
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
      },
    );
  });

  describe('getTurbine', () => {
    it('returns the turbine (business key), its farm and its latest reading with rules', async () => {
      prisma.turbine.findUnique.mockResolvedValue({
        id: '00000000-0000-4000-8000-000000000001',
        turbineId: 'TURB002',
        farmId: 'FARM02',
        latitude: new Prisma.Decimal('41.1'),
        longitude: new Prisma.Decimal('-96.2'),
        commissioned: true,
        farm: {
          id: 'FARM02',
          name: 'High Plains',
          latitude: new Prisma.Decimal('41'),
          longitude: new Prisma.Decimal('-96'),
        },
      } as never);
      prisma.telemetry.findFirst.mockResolvedValue(
        reading([
          { alert: rule('w', 'warn') },
          { alert: rule('e', 'error') },
        ]) as never,
      );

      const turbine = await getTurbine(prisma, 'TURB002');

      expect(prisma.telemetry.findFirst).toHaveBeenCalledWith({
        where: { turbineId: 'TURB002' },
        orderBy: { timestamp: 'desc' }, // measurement time, not arrival
        include: { alerts: { include: { alert: true } } },
      });
      expect(turbine).toMatchObject({
        id: 'TURB002',
        farmId: 'FARM02',
        commissioned: true,
        farm: {
          id: 'FARM02',
          name: 'High Plains',
          latitude: 41,
          longitude: -96,
        },
        latest: { timestamp: '2026-01-02T03:25:00.000Z', gearboxTempC: 126.5 },
      });
      expect(turbine.latest!.alerts.map((a) => a.id)).toEqual(['e', 'w']);
      expect(turbine.latest).not.toHaveProperty('createdAt');
    });

    it('returns latest null for a turbine without readings', async () => {
      prisma.turbine.findUnique.mockResolvedValue({
        turbineId: 'TURB003',
        farmId: 'FARM01',
        latitude: new Prisma.Decimal('1'),
        longitude: new Prisma.Decimal('2'),
        commissioned: false,
        farm: {
          id: 'FARM01',
          name: 'Prairie Ridge',
          latitude: new Prisma.Decimal('1'),
          longitude: new Prisma.Decimal('2'),
        },
      } as never);
      prisma.telemetry.findFirst.mockResolvedValue(null);

      expect((await getTurbine(prisma, 'TURB003')).latest).toBeNull();
    });

    it('throws QueryNotFoundError for an unknown turbine', async () => {
      prisma.turbine.findUnique.mockResolvedValue(null);

      await expect(getTurbine(prisma, 'TURB999')).rejects.toThrow(
        new QueryNotFoundError('Turbine TURB999 not found'),
      );
      expect(prisma.telemetry.findFirst).not.toHaveBeenCalled();
    });
  });

  describe('alertsInRange', () => {
    it('rejects a range over 31 days without querying', async () => {
      await expect(
        alertsInRange(prisma, {
          from: '2026-01-01T00:00:00Z',
          to: '2026-02-01T00:00:01Z',
        }),
      ).rejects.toThrow(
        new QueryInputError('The range may span at most 31 days'),
      );
      expect(prisma.telemetry.findMany).not.toHaveBeenCalled();
    });
  });

  describe('listAlertRules', () => {
    it('lists every rule in ALERT_RULE_ORDER by default', async () => {
      prisma.alertConfig.findMany.mockResolvedValue([
        rule('i', 'info'),
      ] as never);

      expect(await listAlertRules(prisma)).toEqual([
        {
          id: 'i',
          measurementMetric: 'gearboxTempC',
          comparison: 'above',
          valueMetric: 120,
          alertLevel: 'info',
          enabled: false,
        },
      ]);
      expect(prisma.alertConfig.findMany).toHaveBeenCalledWith({
        orderBy: ALERT_RULE_ORDER,
      });
    });

    it('lists only enabled rules when disabled ones are excluded', async () => {
      prisma.alertConfig.findMany.mockResolvedValue([]);

      await listAlertRules(prisma, { includeDisabled: false });

      expect(prisma.alertConfig.findMany).toHaveBeenCalledWith({
        where: { enabled: true },
        orderBy: ALERT_RULE_ORDER,
      });
    });
  });

  describe('reportTelemetry / reportSummary scope', () => {
    it.each([
      ['reportTelemetry', reportTelemetry],
      ['reportSummary', reportSummary],
    ])(
      '%s rejects neither or both scopes with a QueryInputError',
      async (_, run) => {
        for (const scope of [{}, { farmId: 'FARM02', turbineId: 'TURB002' }]) {
          await expect(run(prisma, { ...scope, ...RANGE })).rejects.toThrow(
            new QueryInputError('Provide exactly one of farmId or turbineId'),
          );
        }
        expect(prisma.telemetry.findMany).not.toHaveBeenCalled();
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
      },
    );

    it('reportSummary throws QueryNotFoundError for an unknown farm', async () => {
      prisma.farm.findUnique.mockResolvedValue(null);

      await expect(
        reportSummary(prisma, { farmId: 'FARM99', ...RANGE }),
      ).rejects.toThrow(new QueryNotFoundError('Farm FARM99 not found'));
    });
  });

  describe('reportSummary', () => {
    beforeEach(() => {
      prisma.farm.findUnique.mockResolvedValue({
        id: 'FARM02',
        name: 'High Plains',
      } as never);
    });

    it('aggregates the scope’s readings in [from, to) in Postgres', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            count: 3,
            first_timestamp: new Date('2026-01-02T03:20:00Z'),
            last_timestamp: new Date('2026-01-02T03:30:00Z'),
            power_output_kw_low: 2100,
            power_output_kw_avg: 2150,
            power_output_kw_high: 2200,
            wind_speed_ms_low: 7.5,
            wind_speed_ms_avg: 8,
            wind_speed_ms_high: 8.5,
            rotor_rpm_low: 13,
            rotor_rpm_avg: 13,
            rotor_rpm_high: 13,
            blade_pitch_deg_low: 4,
            blade_pitch_deg_avg: 4,
            blade_pitch_deg_high: 4,
            gearbox_temp_c_low: 126.5,
            gearbox_temp_c_avg: 126.5,
            gearbox_temp_c_high: 126.5,
          },
        ])
        .mockResolvedValueOnce([
          { level: 'error', triggers: 3, readings: 3 },
          { level: 'warn', triggers: 3, readings: 3 },
          { level: null, triggers: 6, readings: 3 }, // the ROLLUP total
        ]);

      const summary = await reportSummary(prisma, {
        farmId: 'FARM02',
        ...RANGE,
      });

      expect(summary).toEqual({
        scope: {
          kind: 'farm',
          id: 'FARM02',
          name: 'High Plains',
          farmId: 'FARM02',
        },
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-03T00:00:00.000Z',
        count: 3,
        firstTimestamp: '2026-01-02T03:20:00.000Z',
        lastTimestamp: '2026-01-02T03:30:00.000Z',
        metrics: {
          powerOutputKw: { low: 2100, avg: 2150, high: 2200 },
          windSpeedMs: { low: 7.5, avg: 8, high: 8.5 },
          rotorRpm: { low: 13, avg: 13, high: 13 },
          bladePitchDeg: { low: 4, avg: 4, high: 4 },
          gearboxTempC: { low: 126.5, avg: 126.5, high: 126.5 },
        },
        flaggedReadings: 3,
        alertsByLevel: {
          error: { triggers: 3, readings: 3 },
          warn: { triggers: 3, readings: 3 },
          info: { triggers: 0, readings: 0 },
        },
      });

      const aggregate = rawQuery(prisma, 0);
      expect(aggregate.text).toContain(
        'WHERE r.farm_id = ? AND r.timestamp >= ? AND r.timestamp < ?',
      );
      expect(aggregate.text).toContain('count(*)::int AS count');
      expect(aggregate.text).toContain(
        'min(r.gearbox_temp_c) AS gearbox_temp_c_low, avg(r.gearbox_temp_c) AS gearbox_temp_c_avg, max(r.gearbox_temp_c) AS gearbox_temp_c_high',
      );
      expect(aggregate.values).toEqual([
        'FARM02',
        new Date('2026-01-01T00:00:00Z'),
        new Date('2026-01-03T00:00:00Z'),
      ]);
      expect(rawQuery(prisma, 1).text).toContain(
        'GROUP BY ROLLUP (c.alert_level)',
      );
    });

    it('filters a turbine by its business key and returns nulls for an empty window', async () => {
      prisma.turbine.findUnique.mockResolvedValue({
        turbineId: 'TURB002',
        farmId: 'FARM02',
        farm: { name: 'High Plains' },
      } as never);
      prisma.$queryRaw
        .mockResolvedValueOnce([
          { count: 0, first_timestamp: null, last_timestamp: null },
        ])
        .mockResolvedValueOnce([{ level: null, triggers: 0, readings: 0 }]);

      const summary = await reportSummary(prisma, {
        turbineId: 'TURB002',
        ...RANGE,
      });

      expect(rawQuery(prisma, 0).text).toContain('WHERE r.turbine_id = ?');
      expect(summary).toMatchObject({
        count: 0,
        firstTimestamp: null,
        lastTimestamp: null,
        metrics: { powerOutputKw: null, gearboxTempC: null },
        flaggedReadings: 0,
      });
    });
  });
});
