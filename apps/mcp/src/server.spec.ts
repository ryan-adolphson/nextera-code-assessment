import { Prisma, type PrismaClient } from '@nextera/shared';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { connectClient } from './testing.js';

const NOW = Date.parse('2026-01-02T00:20:00Z');
const RANGE = { from: '2026-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' };

const turbineRow = (turbineId: string, farmId = 'FARM01') => ({
  id: `uuid-${turbineId}`,
  turbineId,
  farmId,
  latitude: new Prisma.Decimal('41.263'),
  longitude: new Prisma.Decimal('-96.518'),
  commissioned: true,
});

const telemetryRow = (turbineId: string, timestamp: string) => ({
  id: `r-${turbineId}`,
  turbine_id: turbineId,
  farm_id: 'FARM01',
  timestamp: new Date(timestamp),
  received_at: new Date(timestamp),
  created_at: new Date(timestamp),
  power_output_kw: 0,
  wind_speed_ms: 15.8,
  rotor_rpm: 0,
  blade_pitch_deg: 90,
  gearbox_temp_c: 40,
});

describe('MCP server (mocked Prisma)', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let mcp: Awaited<ReturnType<typeof connectClient>>;
  let log: ReturnType<typeof vi.fn<(message: string) => void>>;

  beforeEach(async () => {
    prisma = mockDeep<PrismaClient>();
    log = vi.fn<(message: string) => void>();
    mcp = await connectClient(prisma, { now: () => NOW, log });
  });

  afterEach(async () => {
    await mcp.close();
  });

  it('lists the 7 read-only tools with their input schemas', async () => {
    const { tools } = await mcp.client.listTools();

    expect(tools.map((t) => t.name)).toEqual([
      'list_farms',
      'get_turbine',
      'get_telemetry',
      'get_telemetry_stats',
      'list_alerts',
      'list_alert_rules',
      'get_report_summary',
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });
      expect(tool.description).toBeTruthy();
    }
    const telemetry = tools.find((t) => t.name === 'get_telemetry')!;
    expect(telemetry.inputSchema.required).toEqual(['turbineId']);
    expect(telemetry.inputSchema.properties!.limit).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 2016,
      default: 288,
    });
  });

  describe('input validation (isError, no query)', () => {
    it.each([
      [
        'a week-date timestamp',
        'list_alerts',
        { from: '2026-W01-4', to: RANGE.to },
        'from must be an ISO 8601 date-time with a time zone',
      ],
      [
        'a zone-less timestamp',
        'get_telemetry',
        { turbineId: 'TURB001', to: '2026-01-02T00:00:00' },
        'to must be an ISO 8601 date-time with a time zone',
      ],
      [
        'an impossible calendar date',
        'get_report_summary',
        { farmId: 'FARM01', from: '2026-02-30T00:00:00Z', to: RANGE.to },
        'from must be a real calendar date and time',
      ],
      [
        'a limit over 2016',
        'get_telemetry',
        { turbineId: 'TURB001', limit: 2017 },
        'limit',
      ],
      ['a missing turbineId', 'get_telemetry_stats', {}, 'turbineId'],
    ])('rejects %s', async (_, tool, args, message) => {
      const result = await mcp.call(tool, args);

      expect(result.isError).toBe(true);
      expect(result.text).toContain(message);
      expect(prisma.turbine.findUnique).not.toHaveBeenCalled();
      expect(prisma.telemetry.findMany).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it.each([
      ['list_alerts', RANGE],
      ['get_report_summary', { farmId: 'FARM01', ...RANGE }],
    ])(
      '%s rejects a range over 31 days or a reversed one',
      async (tool, base) => {
        prisma.farm.findUnique.mockResolvedValue({
          id: 'FARM01',
          name: 'F',
        } as never);

        const long = await mcp.call(tool, {
          ...base,
          from: '2026-01-01T00:00:00Z',
          to: '2026-02-01T00:00:01Z',
        });
        const reversed = await mcp.call(tool, {
          ...base,
          from: RANGE.to,
          to: RANGE.from,
        });

        expect(long).toMatchObject({
          isError: true,
          text: 'The range may span at most 31 days',
        });
        expect(reversed).toMatchObject({
          isError: true,
          text: 'to must be after from',
        });
        expect(prisma.telemetry.findMany).not.toHaveBeenCalled();
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['neither', {}],
      ['both', { farmId: 'FARM01', turbineId: 'TURB001' }],
    ])(
      'get_report_summary rejects %s of farmId and turbineId',
      async (_, scope) => {
        const result = await mcp.call('get_report_summary', {
          ...scope,
          ...RANGE,
        });

        expect(result).toMatchObject({
          isError: true,
          text: 'Provide exactly one of farmId or turbineId',
        });
      },
    );
  });

  it.each([
    ['get_turbine', { turbineId: 'TURB999' }],
    ['get_telemetry', { turbineId: 'TURB999' }],
    ['get_telemetry_stats', { turbineId: 'TURB999' }],
    ['get_report_summary', { turbineId: 'TURB999', ...RANGE }],
  ])('%s reports an unknown turbine as an error result', async (tool, args) => {
    prisma.turbine.findUnique.mockResolvedValue(null);

    expect(await mcp.call(tool, args)).toMatchObject({
      isError: true,
      text: 'Turbine TURB999 not found',
    });
  });

  it('reports a database failure as an error result and logs it to stderr, not stdout', async () => {
    prisma.alertConfig.findMany.mockRejectedValue(
      new Error('connect ECONNREFUSED 127.0.0.1:5433\n    at internal'),
    );

    const result = await mcp.call('list_alert_rules');

    expect(result).toMatchObject({
      isError: true,
      text: 'The query failed: connect ECONNREFUSED 127.0.0.1:5433',
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });

  it('list_farms adds each turbine’s status from the clock', async () => {
    prisma.farm.findMany.mockResolvedValue([
      {
        id: 'FARM01',
        name: 'Prairie Ridge',
        latitude: new Prisma.Decimal('41.25'),
        longitude: new Prisma.Decimal('-96.53'),
        turbines: [turbineRow('TURB001'), turbineRow('TURB003')],
      },
    ] as never);
    // 25 minutes before NOW: stale-15.
    prisma.$queryRaw.mockResolvedValue([
      telemetryRow('TURB001', '2026-01-01T23:55:00Z'),
    ]);
    prisma.telemetryAlert.findMany.mockResolvedValue([]);

    const result = (await mcp.call('list_farms')).json();

    expect(result).toMatchObject({
      asOf: '2026-01-02T00:20:00.000Z',
      farmCount: 1,
      turbineCount: 2,
      statusCounts: { 'stale-15': 1, 'no-data': 1 },
    });
    expect(result.farms[0].turbines).toEqual([
      {
        id: 'TURB001',
        commissioned: true,
        status: 'stale-15',
        statusLabel: 'No data in 15 min',
        minutesSinceLatest: 25,
        latest: {
          timestamp: '2026-01-01T23:55:00.000Z',
          receivedAt: '2026-01-01T23:55:00.000Z',
          powerOutputKw: 0,
          windSpeedMs: 15.8,
          rotorRpm: 0,
          bladePitchDeg: 90,
          gearboxTempC: 40,
          alerts: [],
        },
      },
      {
        id: 'TURB003',
        commissioned: true,
        status: 'no-data',
        statusLabel: 'No readings yet',
        minutesSinceLatest: null,
        latest: null,
      },
    ]);
  });

  it('get_telemetry passes the window to the shared query and returns rows by column', async () => {
    prisma.turbine.findUnique.mockResolvedValue({
      turbineId: 'TURB002',
    } as never);
    prisma.telemetry.findMany.mockResolvedValue([
      {
        id: 'r1',
        turbineId: 'TURB002',
        farmId: 'FARM02',
        timestamp: new Date('2026-01-02T03:25:00Z'),
        receivedAt: new Date('2026-01-02T03:26:00Z'),
        createdAt: new Date('2026-01-02T03:26:00Z'),
        powerOutputKw: 2200,
        windSpeedMs: 10.7,
        rotorRpm: 12.8,
        bladePitchDeg: 3.8,
        gearboxTempC: 126.5,
        alerts: [
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
        ],
      },
    ] as never);

    const result = (
      await mcp.call('get_telemetry', {
        turbineId: 'TURB002',
        from: '2026-01-02T03:00:00Z',
        to: '2026-01-02T04:00:00Z',
      })
    ).json();

    expect(prisma.telemetry.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          turbineId: 'TURB002',
          timestamp: {
            gte: new Date('2026-01-02T03:00:00Z'),
            lt: new Date('2026-01-02T04:00:00Z'),
          },
        },
        take: 288, // the default limit
      }),
    );
    expect(result).toEqual({
      turbineId: 'TURB002',
      count: 1,
      columns: [
        'timestamp',
        'powerOutputKw',
        'windSpeedMs',
        'rotorRpm',
        'bladePitchDeg',
        'gearboxTempC',
        'alerts',
      ],
      rows: [
        [
          '2026-01-02T03:25:00.000Z',
          2200,
          10.7,
          12.8,
          3.8,
          126.5,
          ['error: gearboxTempC 126.5 above 120'],
        ],
      ],
    });
  });

  it('list_alert_rules can leave out disabled rules', async () => {
    prisma.alertConfig.findMany.mockResolvedValue([]);

    await mcp.call('list_alert_rules', { includeDisabled: false });

    expect(prisma.alertConfig.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { enabled: true } }),
    );
  });
});
