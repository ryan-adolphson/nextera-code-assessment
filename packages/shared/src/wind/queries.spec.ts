import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { Prisma, type PrismaClient } from '../generated/prisma/client.js';
import {
  ALERT_RULE_ORDER,
  QueryError,
  QueryInputError,
  QueryNotFoundError,
  MAX_REPORT_ROWS,
  QueryTooLargeError,
  anomaliesInRange,
  listFarms,
  checkTimeZone,
  farmWeather,
  getTurbine,
  listAnomalies,
  listAlertRules,
  listUnallocated,
  parseRange,
  reportSummary,
  reportTelemetry,
  telemetryStats,
  turbineTelemetry,
  turbineWeather,
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
      // turbine_latest row, then the (reading id, timestamp) → rule links
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            turbine_id: 'TURB002',
            farm_id: 'FARM02',
            reading_id: 'r1',
            l_timestamp: new Date('2026-01-02T03:25:00Z'),
            received_at: new Date('2026-01-02T03:26:00Z'),
            power_output_kw: 2200,
            wind_speed_ms: 8.5,
            rotor_rpm: 13,
            blade_pitch_deg: 4,
            gearbox_temp_c: 126.5,
          },
        ])
        .mockResolvedValueOnce([
          { telemetry_id: 'r1', alert_id: 'w' },
          { telemetry_id: 'r1', alert_id: 'e' },
        ]);
      prisma.alertConfig.findMany.mockResolvedValue([
        rule('w', 'warn'),
        rule('e', 'error'),
      ] as never);

      const turbine = await getTurbine(prisma, 'TURB002');

      expect(rawQuery(prisma, 0).text).toContain('FROM turbine_latest l');
      expect(rawQuery(prisma, 1).text).toContain('telemetry_alerts ta');
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
      prisma.$queryRaw.mockResolvedValue([]);

      expect((await getTurbine(prisma, 'TURB003')).latest).toBeNull();
    });

    it('throws QueryNotFoundError for an unknown turbine', async () => {
      prisma.turbine.findUnique.mockResolvedValue(null);

      await expect(getTurbine(prisma, 'TURB999')).rejects.toThrow(
        new QueryNotFoundError('Turbine TURB999 not found'),
      );
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('listAnomalies', () => {
    it.each([
      ['to', RANGE.from, RANGE.from, 'to must be after from'],
      [
        'long',
        '2026-01-01T00:00:00Z',
        '2026-02-01T00:00:01Z',
        'The range may span at most 31 days',
      ],
    ])('rejects a bad range (%s) without querying', async (_, from, to, m) => {
      await expect(listAnomalies(prisma, { from, to })).rejects.toThrow(
        new QueryInputError(m),
      );
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('listFarms (deprecated)', () => {
    it('throws QueryTooLargeError above 5,000 turbines before loading anything', async () => {
      prisma.$queryRaw.mockResolvedValue([{ n: 5001 }]);

      await expect(listFarms(prisma)).rejects.toBeInstanceOf(
        QueryTooLargeError,
      );
      expect(prisma.farm.findMany).not.toHaveBeenCalled();
    });
  });

  describe('anomaliesInRange', () => {
    const MIN = 60_000;
    const episode = (over: Record<string, unknown>) => ({
      id: 'e',
      kind: 'low_power_in_wind',
      metric: null,
      turbineId: 'TURB001',
      farmId: 'FARM01',
      episodeStart: new Date('2026-01-01T13:40:00Z'),
      episodeEnd: new Date('2026-01-01T13:50:00Z'),
      readings: 3,
      value: null,
      windSpeedMs: 15.8,
      lostKwh: 9,
      computedAt: new Date(),
      ...over,
    });

    it.each([
      ['to', RANGE.from, RANGE.from, 'to must be after from'],
      [
        'long',
        '2026-01-01T00:00:00Z',
        '2026-02-01T00:00:01Z',
        'The range may span at most 31 days',
      ],
    ])('rejects a bad range (%s) without querying', async (_, from, to, m) => {
      await expect(anomaliesInRange(prisma, { from, to })).rejects.toThrow(
        new QueryInputError(m),
      );
      expect(prisma.anomalyEpisode.findMany).not.toHaveBeenCalled();
    });

    it('selects the episodes overlapping the range, newest end first', async () => {
      prisma.anomalyEpisode.findMany.mockResolvedValue([]);

      await anomaliesInRange(prisma, RANGE);

      expect(prisma.anomalyEpisode.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            episodeEnd: { gte: new Date(RANGE.from) },
            episodeStart: { lt: new Date(RANGE.to) },
          },
        }),
      );
    });

    it('returns an episode inside the range whole', async () => {
      prisma.anomalyEpisode.findMany.mockResolvedValue([episode({})] as never);

      const result = await anomaliesInRange(prisma, RANGE);

      expect(result.anomalies).toEqual([
        expect.objectContaining({
          start: '2026-01-01T13:40:00.000Z',
          end: '2026-01-01T13:50:00.000Z',
          readings: 3,
          estimatedLostKwh: 9,
        }),
      ]);
      expect(result.estimatedLostKwh).toBe(9);
    });

    it('clips an episode crossing the range start: readings, start and lost kWh pro rata', async () => {
      // 12 readings 13:00-13:55, 120 kWh; the range starts at 13:30 → 13:30..13:55 = 6 readings
      prisma.anomalyEpisode.findMany.mockResolvedValue([
        episode({
          episodeStart: new Date('2026-01-01T13:00:00Z'),
          episodeEnd: new Date('2026-01-01T13:55:00Z'),
          readings: 12,
          lostKwh: 120,
        }),
      ] as never);

      const result = await anomaliesInRange(prisma, {
        from: '2026-01-01T13:30:00Z',
        to: '2026-01-02T00:00:00Z',
      });

      expect(result.anomalies[0]).toMatchObject({
        start: '2026-01-01T13:30:00.000Z',
        end: '2026-01-01T13:55:00.000Z',
        readings: 6,
        estimatedLostKwh: 60,
      });
    });

    it('clips the end to the last reading before `to` (exclusive)', async () => {
      prisma.anomalyEpisode.findMany.mockResolvedValue([
        episode({
          kind: 'stuck_sensor',
          metric: 'gearboxTempC',
          episodeStart: new Date('2026-01-01T13:00:00Z'),
          episodeEnd: new Date('2026-01-01T14:55:00Z'), // 24 readings
          readings: 24,
          value: 126.5,
          windSpeedMs: null,
          lostKwh: null,
        }),
      ] as never);

      const result = await anomaliesInRange(prisma, {
        from: '2026-01-01T00:00:00Z',
        to: '2026-01-01T14:00:00Z',
      });

      // 13:00..13:55 = 12 readings (14:00 is excluded), exactly the stuck minimum
      expect(result.anomalies[0]).toMatchObject({
        end: '2026-01-01T13:55:00.000Z',
        readings: 12,
        estimatedLostKwh: null,
      });
    });

    it('drops an episode whose part in the range is shorter than its rule needs', async () => {
      prisma.anomalyEpisode.findMany.mockResolvedValue([
        episode({
          episodeStart: new Date(Date.parse('2026-01-01T00:00:00Z') - 10 * MIN),
          episodeEnd: new Date(Date.parse('2026-01-01T00:00:00Z') + 5 * MIN),
          readings: 4,
        }), // 00:00 and 00:05 are in the range: 2 < 3
      ] as never);

      const result = await anomaliesInRange(prisma, RANGE);

      expect(result.anomalies).toEqual([]);
      expect(result.estimatedLostKwh).toBe(0);
    });

    it('flags truncation past the cap', async () => {
      prisma.anomalyEpisode.findMany.mockResolvedValue(
        Array.from({ length: 5001 }, () => episode({})) as never,
      );

      const result = await anomaliesInRange(prisma, RANGE);

      expect(result.anomalies).toHaveLength(5000);
      expect(result.truncated).toBe(true);
    });
  });

  describe('reportTelemetry row cap', () => {
    it('refuses a report over MAX_REPORT_ROWS before loading rows', async () => {
      prisma.farm.findUnique.mockResolvedValue({
        id: 'FARM02',
        name: 'x',
      } as never);
      prisma.$queryRaw.mockResolvedValue([{ n: MAX_REPORT_ROWS + 1 }]);

      await expect(
        reportTelemetry(prisma, { farmId: 'FARM02', ...RANGE }),
      ).rejects.toThrow(/more than 100,000 readings/);
      expect(prisma.telemetry.findMany).not.toHaveBeenCalled();
      expect(rawQuery(prisma, 0).text).toContain('LIMIT ?');
      expect(rawQuery(prisma, 0).values).toContain(MAX_REPORT_ROWS + 1);
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
      // the alerts join carries the partition key, so both tables prune
      expect(rawQuery(prisma, 1).text).toContain(
        'ta.reading_timestamp = r.timestamp AND ta.reading_timestamp >= ? AND ta.reading_timestamp < ?',
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

  describe('listUnallocated', () => {
    beforeEach(() => {
      prisma.unallocatedTurbine.findMany.mockResolvedValue([]);
    });

    it.each([
      ['no filter: pending', undefined, { status: 'pending' }],
      ['a status', { status: 'blocked' as const }, { status: 'blocked' }],
      [
        'a turbine id',
        { turbineId: 'TURB003' },
        { status: 'pending', turbineId: 'TURB003' },
      ],
    ])('filters by %s', async (_, filter, where) => {
      expect(await listUnallocated(prisma, filter)).toEqual([]);

      expect(prisma.unallocatedTurbine.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where }),
      );
      // No entries: nothing else is read.
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('checkTimeZone', () => {
    const ZONE_ERROR = new QueryInputError(
      'timeZone must be an IANA time zone name, e.g. "America/Chicago" (default "UTC")',
    );

    it('accepts UTC without asking Postgres', async () => {
      expect(await checkTimeZone(prisma, 'UTC')).toBe('UTC');
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('asks pg_timezone_names once per zone, with the name bound', async () => {
      prisma.$queryRaw.mockResolvedValue([{ known: true }]);

      expect(await checkTimeZone(prisma, 'America/Chicago')).toBe(
        'America/Chicago',
      );
      expect(await checkTimeZone(prisma, 'America/Chicago')).toBe(
        'America/Chicago',
      );

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      const [strings, ...values] = prisma.$queryRaw.mock
        .calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
      const sql = Prisma.sql(strings, ...values);
      expect(sql.sql).toContain('FROM pg_timezone_names WHERE name = ?');
      expect(sql.values).toEqual(['America/Chicago']);
    });

    it('rejects a name Postgres does not know', async () => {
      prisma.$queryRaw.mockResolvedValue([{ known: false }]);
      await expect(checkTimeZone(prisma, 'Mars/Olympus')).rejects.toThrow(
        ZONE_ERROR,
      );
      // Not cached: asked again.
      await expect(checkTimeZone(prisma, 'Mars/Olympus')).rejects.toThrow(
        ZONE_ERROR,
      );
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it.each([
      ['a POSIX offset spec', 'UTC+6:00'],
      ['SQL', "UTC'; DROP TABLE farms; --"],
      ['an empty name', ''],
      ['a path', '../etc/passwd'],
      ['a long name', `A/${'b'.repeat(70)}`],
    ])('rejects %s before querying', async (_, zone) => {
      await expect(checkTimeZone(prisma, zone)).rejects.toThrow(ZONE_ERROR);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('farmWeather / turbineWeather', () => {
    const DAY = { from: '2026-11-01T00:00:00Z', to: '2026-11-02T00:00:00Z' };

    it('turbineWeather throws QueryNotFoundError for an unknown turbine', async () => {
      prisma.turbine.findUnique.mockResolvedValue(null);

      await expect(
        turbineWeather(prisma, 'TURB999', { ...DAY, interval: '30min' }),
      ).rejects.toThrow(new QueryNotFoundError('Turbine TURB999 not found'));
      expect(prisma.farmWeather.findMany).not.toHaveBeenCalled();
    });

    it("turbineWeather reads the turbine's farm, with the turbine id", async () => {
      prisma.turbine.findUnique.mockResolvedValue({
        farmId: 'FARM02',
      } as never);
      prisma.farmWeather.findMany.mockResolvedValue([]);

      const result = await turbineWeather(prisma, 'TURB002', {
        ...DAY,
        interval: '30min',
      });

      expect(prisma.turbine.findUnique).toHaveBeenCalledWith({
        where: { turbineId: 'TURB002' },
        select: { farmId: true },
      });
      expect(prisma.farm.findUnique).not.toHaveBeenCalled();
      expect(prisma.farmWeather.findMany).toHaveBeenCalledWith({
        where: {
          farmId: 'FARM02',
          time: { gte: new Date(DAY.from), lt: new Date(DAY.to) },
        },
        orderBy: { time: 'asc' },
      });
      expect(Object.keys(result)).toEqual([
        'farmId',
        'turbineId',
        'from',
        'to',
        'interval',
        'timeZone',
        'points',
      ]);
      expect(result).toEqual({
        farmId: 'FARM02',
        turbineId: 'TURB002',
        from: '2026-11-01T00:00:00.000Z',
        to: '2026-11-02T00:00:00.000Z',
        interval: '30min',
        timeZone: 'UTC',
        points: [],
      });
    });

    it('buckets daily points by local day in the bound zone', async () => {
      prisma.farm.findUnique.mockResolvedValue({ id: 'FARM01' } as never);
      prisma.$queryRaw
        .mockResolvedValueOnce([{ known: true }]) // pg_timezone_names
        .mockResolvedValueOnce([]);

      const result = await farmWeather(prisma, 'FARM01', {
        ...DAY,
        interval: 'daily',
        timeZone: 'Europe/Berlin',
      });

      expect(result).toMatchObject({
        interval: 'daily',
        timeZone: 'Europe/Berlin',
        points: [],
      });
      const [strings, ...values] = prisma.$queryRaw.mock
        .calls[1] as unknown as [TemplateStringsArray, ...unknown[]];
      const sql = Prisma.sql(strings, ...values);
      expect(sql.sql.replace(/\s+/g, ' ')).toContain(
        "to_char(w.time AT TIME ZONE ?::text, 'YYYY-MM-DD') AS day",
      );
      expect(sql.values).toEqual([
        'Europe/Berlin',
        'FARM01',
        new Date(DAY.from),
        new Date(DAY.to),
      ]);
    });

    it('rejects a bad range before checking the zone', async () => {
      prisma.turbine.findUnique.mockResolvedValue({
        farmId: 'FARM02',
      } as never);

      await expect(
        turbineWeather(prisma, 'TURB002', {
          from: DAY.to,
          to: DAY.from,
          interval: 'daily',
          timeZone: 'Asia/Tokyo',
        }),
      ).rejects.toThrow(new QueryInputError('to must be after from'));
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });
});
