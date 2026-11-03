import { Prisma, type PrismaClient } from '@nextera/shared';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { connectClient } from './testing.js';

const NOW = Date.parse('2026-01-02T00:20:00Z');
const RANGE = { from: '2026-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' };
const ENTRY_ID = '3f0c6a2e-8d4b-4c1e-9a57-2b6f0e1d9c44';

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

  it('lists the 11 read-only tools with their input schemas', async () => {
    const { tools } = await mcp.client.listTools();

    expect(tools.map((t) => t.name)).toEqual([
      'list_farms',
      'get_turbine',
      'get_telemetry',
      'get_telemetry_stats',
      'list_alerts',
      'list_alert_rules',
      'get_report_summary',
      'get_weather',
      'get_farm_daily',
      'list_unallocated',
      'get_unallocated_readings',
    ]);
    for (const tool of tools) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });
      expect(tool.description).toBeTruthy();
      // Strict objects: a client that validates against the schema rejects unknown keys too.
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    const telemetry = tools.find((t) => t.name === 'get_telemetry')!;
    expect(telemetry.inputSchema.required).toEqual(['turbineId']);
    expect(telemetry.inputSchema.properties!.limit).toMatchObject({
      type: 'integer',
      minimum: 1,
      maximum: 2016,
      default: 288,
    });
    expect(telemetry.inputSchema.properties!.from).toMatchObject({
      type: 'string',
      description: expect.stringContaining('Inclusive lower bound'),
    });
    expect(Object.keys(telemetry.inputSchema.properties!)).toEqual([
      'turbineId',
      'from',
      'to',
      'limit',
    ]);
    const weather = tools.find((t) => t.name === 'get_weather')!;
    expect(weather.inputSchema.required).toEqual(['from', 'to']);
    expect(Object.keys(weather.inputSchema.properties!)).toEqual([
      'farmId',
      'turbineId',
      'from',
      'to',
      'interval',
      'timeZone',
    ]);
    expect(weather.inputSchema.properties!.interval).toMatchObject({
      enum: ['30min', 'daily'],
      default: 'daily',
    });
    expect(weather.inputSchema.properties!.timeZone).toMatchObject({
      type: 'string',
      default: 'UTC',
    });
    const daily = tools.find((t) => t.name === 'get_farm_daily')!;
    expect(daily.inputSchema.required).toEqual(['farmId', 'from', 'to']);
    expect(Object.keys(daily.inputSchema.properties!)).toEqual([
      'farmId',
      'from',
      'to',
      'timeZone',
    ]);
    expect(daily.inputSchema.properties!.timeZone).toMatchObject({
      type: 'string',
      default: 'UTC',
    });
    const unallocated = tools.find((t) => t.name === 'list_unallocated')!;
    expect(unallocated.inputSchema.properties!.status).toMatchObject({
      enum: ['pending', 'blocked'],
      default: 'pending',
    });
    const held = tools.find((t) => t.name === 'get_unallocated_readings')!;
    expect(held.inputSchema.required).toEqual(['id']);
    expect(held.inputSchema.properties!.limit).toMatchObject({
      maximum: 2016,
      default: 288,
    });
    const farms = tools.find((t) => t.name === 'list_farms')!;
    expect(farms.inputSchema).toMatchObject({
      type: 'object',
      properties: {},
      additionalProperties: false,
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
      [
        'a limit given as a string (no coercion)',
        'get_telemetry',
        { turbineId: 'TURB001', limit: '12' },
        'limit',
      ],
      [
        'a whitespace-only turbineId',
        'get_telemetry',
        { turbineId: '  ' },
        'turbineId',
      ],
      [
        'an unknown weather interval',
        'get_weather',
        { farmId: 'FARM01', ...RANGE, interval: 'weekly' },
        'interval',
      ],
      [
        'the removed hourly interval',
        'get_weather',
        { farmId: 'FARM01', ...RANGE, interval: 'hourly' },
        'interval',
      ],
      [
        'neither farmId nor turbineId',
        'get_weather',
        { ...RANGE },
        'Provide exactly one of farmId or turbineId',
      ],
      [
        'both farmId and turbineId',
        'get_weather',
        { farmId: 'FARM01', turbineId: 'TURB001', ...RANGE },
        'Provide exactly one of farmId or turbineId',
      ],
      [
        'a weather range without to',
        'get_weather',
        { farmId: 'FARM01', from: RANGE.from },
        'to',
      ],
      [
        'a zone-less weather bound',
        'get_weather',
        { farmId: 'FARM01', from: '2026-01-01T00:00:00', to: RANGE.to },
        'from must be an ISO 8601 date-time with a time zone',
      ],
      [
        'an unknown unallocated status',
        'list_unallocated',
        { status: 'resolved' },
        'status',
      ],
      [
        'a turbine id instead of an entry id',
        'get_unallocated_readings',
        { id: 'TURB099' },
        'id must be the UUID of an entry from list_unallocated',
      ],
      [
        'a held-readings limit over 2016',
        'get_unallocated_readings',
        { id: ENTRY_ID, limit: 2017 },
        'limit',
      ],
    ])('rejects %s', async (_, tool, args, message) => {
      const result = await mcp.call(tool, args);

      expect(result.isError).toBe(true);
      expect(result.text).toContain(message);
      expect(prisma.turbine.findUnique).not.toHaveBeenCalled();
      expect(prisma.telemetry.findMany).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.farm.findUnique).not.toHaveBeenCalled();
      expect(prisma.unallocatedTurbine.findMany).not.toHaveBeenCalled();
      expect(prisma.unallocatedTurbine.findUnique).not.toHaveBeenCalled();
    });

    it('rejects a misspelled argument instead of dropping it (get_telemetry form → from)', async () => {
      const result = await mcp.call('get_telemetry', {
        turbineId: 'TURB001',
        form: '2026-01-01T00:00:00Z',
      });

      expect(result.isError).toBe(true);
      expect(result.text).toBe(
        'MCP error -32602: Input validation error: Invalid arguments for tool get_telemetry: ' +
          'Unrecognized key: "form"',
      );
      expect(prisma.turbine.findUnique).not.toHaveBeenCalled();
      expect(prisma.telemetry.findMany).not.toHaveBeenCalled();
    });

    it.each([
      ['list_farms', { farmId: 'FARM01' }, 'farmId'],
      ['get_turbine', { turbineId: 'TURB001', id: 'TURB001' }, 'id'],
      ['get_telemetry_stats', { turbineId: 'TURB001', since: 'x' }, 'since'],
      ['list_alerts', { ...RANGE, turbineId: 'TURB001' }, 'turbineId'],
      ['list_alert_rules', { enabled: true }, 'enabled'],
      ['get_report_summary', { farmId: 'FARM01', ...RANGE, limit: 5 }, 'limit'],
      ['get_weather', { farmId: 'FARM01', ...RANGE, zone: 'UTC' }, 'zone'],
      [
        'get_farm_daily',
        { farmId: 'FARM01', ...RANGE, metric: 'power' },
        'metric',
      ],
      ['list_unallocated', { status: 'pending', farmId: 'FARM01' }, 'farmId'],
      ['get_unallocated_readings', { id: ENTRY_ID, from: RANGE.from }, 'from'],
    ])('%s rejects an unknown argument, naming it', async (tool, args, key) => {
      const result = await mcp.call(tool, args);

      expect(result.isError).toBe(true);
      expect(result.text).toContain(`Unrecognized key: "${key}"`);
      expect(prisma.farm.findMany).not.toHaveBeenCalled();
      expect(prisma.farm.findUnique).not.toHaveBeenCalled();
      expect(prisma.turbine.findUnique).not.toHaveBeenCalled();
      expect(prisma.telemetry.findMany).not.toHaveBeenCalled();
      expect(prisma.alertConfig.findMany).not.toHaveBeenCalled();
      expect(prisma.unallocatedTurbine.findMany).not.toHaveBeenCalled();
      expect(prisma.heldTelemetry.findMany).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it.each([
      ['list_alerts', RANGE],
      ['get_report_summary', { farmId: 'FARM01', ...RANGE }],
      ['get_weather', { farmId: 'FARM01', ...RANGE }],
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
        expect(prisma.farmWeather.findMany).not.toHaveBeenCalled();
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
    prisma.unallocatedTurbine.findMany.mockResolvedValue([]); // nothing held for it

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

  describe('get_weather', () => {
    const bucket = (time: string) => ({
      farmId: 'FARM01',
      time: new Date(time),
      samples: 2,
      windSpeed10mMs: 6.1,
      windSpeed80mMs: 9.4,
      windDirection10mDeg: 200,
      windDirection80mDeg: 210,
      windGusts10mMs: 12.3,
      temperature2mC: -3.5,
      relativeHumidity2mPct: 80,
      surfacePressureHpa: 1012.5,
      precipitationMm: 0,
      cloudCoverPct: null,
      fetchedAt: new Date(time),
    });

    beforeEach(() => {
      prisma.farm.findUnique.mockResolvedValue({ id: 'FARM01' } as never);
    });

    it('30min: the stored buckets by column', async () => {
      prisma.farmWeather.findMany.mockResolvedValue([
        bucket('2026-01-01T00:00:00Z'),
        bucket('2026-01-01T00:30:00Z'),
      ]);

      const result = (
        await mcp.call('get_weather', {
          farmId: 'FARM01',
          from: '2026-01-01T00:00:00Z',
          to: '2026-01-01T01:00:00+00:00',
          interval: '30min',
        })
      ).json();

      expect(prisma.farmWeather.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            farmId: 'FARM01',
            time: {
              gte: new Date('2026-01-01T00:00:00Z'),
              lt: new Date('2026-01-01T01:00:00Z'),
            },
          },
        }),
      );
      expect(result).toEqual({
        farmId: 'FARM01',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-01T01:00:00.000Z',
        interval: '30min',
        timeZone: 'UTC',
        count: 2,
        columns: [
          'time',
          'samples',
          'windSpeed10mMs',
          'windSpeed80mMs',
          'windDirection10mDeg',
          'windDirection80mDeg',
          'windGusts10mMs',
          'temperature2mC',
          'relativeHumidity2mPct',
          'surfacePressureHpa',
          'precipitationMm',
          'cloudCoverPct',
        ],
        rows: [
          [
            '2026-01-01T00:00:00.000Z',
            2,
            6.1,
            9.4,
            200,
            210,
            12.3,
            -3.5,
            80,
            1012.5,
            0,
            null,
          ],
          [
            '2026-01-01T00:30:00.000Z',
            2,
            6.1,
            9.4,
            200,
            210,
            12.3,
            -3.5,
            80,
            1012.5,
            0,
            null,
          ],
        ],
      });
    });

    it('daily by default: one row per UTC day from Postgres', async () => {
      prisma.$queryRaw.mockResolvedValue([
        {
          day: '2026-01-01',
          samples: 48,
          wind_speed_10m_mean: 6.123,
          wind_speed_10m_max: 9,
          wind_speed_80m_mean: '9.456',
          wind_speed_80m_max: 14,
          wind_direction_80m: 359.999,
          wind_gusts_10m_max: 18.2,
          temperature_2m_min: -8,
          temperature_2m_max: 1,
          temperature_2m_mean: -3.25,
          relative_humidity_2m_mean: 81,
          surface_pressure_mean: 1010,
          precipitation_sum: 0.4,
          cloud_cover_mean: null,
        },
      ]);

      const result = (
        await mcp.call('get_weather', { farmId: 'FARM01', ...RANGE })
      ).json();

      expect(prisma.farmWeather.findMany).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        interval: 'daily',
        timeZone: 'UTC',
        count: 1,
      });
      expect(result).not.toHaveProperty('turbineId');
      expect(result.columns.slice(0, 3)).toEqual([
        'date',
        'samples',
        'windSpeed10mMeanMs',
      ]);
      expect(result.rows).toEqual([
        [
          '2026-01-01',
          48,
          6.12,
          9,
          9.46,
          14,
          0,
          18.2,
          -8,
          1,
          -3.25,
          81,
          1010,
          0.4,
          null,
        ],
      ]);
    });

    it("turbineId: its current farm's weather, with the turbine id and the zone bound", async () => {
      prisma.turbine.findUnique.mockResolvedValue({
        farmId: 'FARM02',
      } as never);
      prisma.$queryRaw
        .mockResolvedValueOnce([{ known: true }]) // pg_timezone_names
        .mockResolvedValueOnce([]);

      const result = (
        await mcp.call('get_weather', {
          turbineId: 'TURB002',
          ...RANGE,
          timeZone: 'America/Phoenix',
        })
      ).json();

      expect(prisma.turbine.findUnique).toHaveBeenCalledWith({
        where: { turbineId: 'TURB002' },
        select: { farmId: true },
      });
      expect(prisma.farm.findUnique).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        farmId: 'FARM02',
        turbineId: 'TURB002',
        interval: 'daily',
        timeZone: 'America/Phoenix',
        count: 0,
        rows: [],
      });
      const [strings, ...values] = prisma.$queryRaw.mock
        .calls[1] as unknown as [TemplateStringsArray, ...unknown[]];
      expect(Prisma.sql(strings, ...values).values[0]).toBe('America/Phoenix');
    });

    it('reports an unknown time zone as an error result', async () => {
      prisma.$queryRaw.mockResolvedValue([{ known: false }]);

      expect(
        await mcp.call('get_weather', {
          farmId: 'FARM01',
          ...RANGE,
          timeZone: 'Mars/Olympus',
        }),
      ).toMatchObject({
        isError: true,
        text: 'timeZone must be an IANA time zone name, e.g. "America/Chicago" (default "UTC")',
      });
    });

    it('an empty range is a result, not an error', async () => {
      prisma.$queryRaw.mockResolvedValue([]);

      const result = await mcp.call('get_weather', {
        farmId: 'FARM01',
        ...RANGE,
      });

      expect(result.isError).toBe(false);
      expect(result.json()).toMatchObject({ count: 0, rows: [] });
    });

    it('reports an unknown farm or turbine as an error result before reading weather', async () => {
      prisma.farm.findUnique.mockResolvedValue(null);
      prisma.turbine.findUnique.mockResolvedValue(null);

      expect(
        await mcp.call('get_weather', { farmId: 'FARM99', ...RANGE }),
      ).toMatchObject({ isError: true, text: 'Farm FARM99 not found' });
      expect(
        await mcp.call('get_weather', { turbineId: 'TURB999', ...RANGE }),
      ).toMatchObject({ isError: true, text: 'Turbine TURB999 not found' });
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('reports a database failure as an error result', async () => {
      prisma.$queryRaw.mockRejectedValue(new Error('canceling statement'));

      expect(
        await mcp.call('get_weather', { farmId: 'FARM01', ...RANGE }),
      ).toMatchObject({
        isError: true,
        text: 'The query failed: canceling statement',
      });
    });
  });

  describe('get_farm_daily', () => {
    const dayRow = {
      day: '2026-01-01',
      turbines: 1,
      readings: 288,
      computed_at: new Date('2026-01-03T00:15:00Z'),
      ...Object.fromEntries(
        [
          'power',
          'wind_speed',
          'rotor_rpm',
          'blade_pitch',
          'gearbox_temp',
        ].flatMap((p) => [
          [`${p}_open`, 1],
          [`${p}_close`, 2],
          [`${p}_high`, 3.456],
          [`${p}_low`, 0],
        ]),
      ),
    };

    beforeEach(() => {
      prisma.farm.findUnique.mockResolvedValue({
        id: 'FARM01',
        _count: { turbines: 2 },
      } as never);
    });

    it('returns the daily candles of the shared query', async () => {
      prisma.$queryRaw.mockResolvedValue([dayRow]);

      const result = await mcp.call('get_farm_daily', {
        farmId: 'FARM01',
        ...RANGE,
      });

      expect(result.isError).toBe(false);
      expect(result.json()).toEqual({
        farmId: 'FARM01',
        from: '2026-01-01T00:00:00.000Z',
        to: '2026-01-03T00:00:00.000Z',
        timeZone: 'UTC',
        turbineCount: 2,
        computedAt: '2026-01-03T00:15:00.000Z',
        days: [
          {
            date: '2026-01-01',
            turbines: 1,
            readings: 288,
            powerOutputKw: { open: 1, close: 2, high: 3.46, low: 0 },
            windSpeedMs: { open: 1, close: 2, high: 3.46, low: 0 },
            rotorRpm: { open: 1, close: 2, high: 3.46, low: 0 },
            bladePitchDeg: { open: 1, close: 2, high: 3.46, low: 0 },
            gearboxTempC: { open: 1, close: 2, high: 3.46, low: 0 },
          },
        ],
      });
    });

    it('allows 183 days, rejects more, a reversed range and an unknown farm', async () => {
      prisma.$queryRaw.mockResolvedValue([]);
      expect(
        (
          await mcp.call('get_farm_daily', {
            farmId: 'FARM01',
            from: '2026-01-01T00:00:00Z',
            to: '2026-07-03T00:00:00Z',
          })
        ).isError,
      ).toBe(false);
      expect(
        await mcp.call('get_farm_daily', {
          farmId: 'FARM01',
          from: '2026-01-01T00:00:00Z',
          to: '2026-07-04T00:00:00Z',
        }),
      ).toMatchObject({
        isError: true,
        text: 'The range may span at most 183 days',
      });
      expect(
        await mcp.call('get_farm_daily', {
          farmId: 'FARM01',
          from: RANGE.to,
          to: RANGE.from,
        }),
      ).toMatchObject({ isError: true, text: 'to must be after from' });
      prisma.farm.findUnique.mockResolvedValue(null);
      expect(
        await mcp.call('get_farm_daily', { farmId: 'FARM99', ...RANGE }),
      ).toMatchObject({ isError: true, text: 'Farm FARM99 not found' });
    });
  });

  describe('unallocated turbines', () => {
    const entryRow = (overrides: Record<string, unknown> = {}) => ({
      id: ENTRY_ID,
      turbineId: 'TURB099',
      reportedFarmId: 'FARM01',
      kind: 'unknown_turbine',
      status: 'pending',
      firstSeenAt: new Date('2026-01-01T18:00:00Z'),
      lastSeenAt: new Date('2026-01-01T23:55:30Z'),
      blockedAt: null,
      blockedById: null,
      blockedBy: null,
      createdAt: new Date('2026-01-01T18:00:00Z'),
      updatedAt: new Date('2026-01-01T23:55:30Z'),
      _count: { held: 72 },
      ...overrides,
    });
    const heldRow = {
      id: 'h1',
      unallocated_id: ENTRY_ID,
      turbine_id: 'TURB099',
      farm_id: 'FARM01',
      timestamp: new Date('2026-01-01T23:55:00Z'),
      received_at: new Date('2026-01-01T23:55:30Z'),
      created_at: new Date('2026-01-01T23:55:30Z'),
      power_output_kw: 1500,
      wind_speed_ms: 9,
      rotor_rpm: 12,
      blade_pitch_deg: 2,
      gearbox_temp_c: 60,
    };
    const farmRef = { id: 'FARM01', name: 'Prairie Ridge' };

    it('list_unallocated: pending entries without the blocking user', async () => {
      prisma.unallocatedTurbine.findMany.mockResolvedValue([
        entryRow(),
      ] as never);
      prisma.$queryRaw.mockResolvedValue([heldRow]);
      prisma.turbine.findMany.mockResolvedValue([]);
      prisma.farm.findMany.mockResolvedValue([farmRef] as never);

      const result = (await mcp.call('list_unallocated')).json();

      expect(prisma.unallocatedTurbine.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { status: 'pending' } }),
      );
      expect(result).toEqual({
        asOf: '2026-01-02T00:20:00.000Z',
        status: 'pending',
        count: 1,
        entries: [
          {
            id: ENTRY_ID,
            turbineId: 'TURB099',
            kind: 'unknown_turbine',
            status: 'pending',
            reportedFarmId: 'FARM01',
            reportedFarm: farmRef,
            currentFarm: null,
            firstSeenAt: '2026-01-01T18:00:00.000Z',
            lastSeenAt: '2026-01-01T23:55:30.000Z',
            minutesSinceLastSeen: 24,
            heldCount: 72,
            latest: {
              timestamp: '2026-01-01T23:55:00.000Z',
              receivedAt: '2026-01-01T23:55:30.000Z',
              powerOutputKw: 1500,
              windSpeedMs: 9,
              rotorRpm: 12,
              bladePitchDeg: 2,
              gearboxTempC: 60,
            },
            blockedAt: null,
          },
        ],
      });
    });

    it('list_unallocated: blocked entries of one turbine, never the blocking user’s email', async () => {
      prisma.unallocatedTurbine.findMany.mockResolvedValue([
        entryRow({
          turbineId: 'TURB005',
          reportedFarmId: 'FARM03',
          status: 'blocked',
          blockedAt: new Date('2026-01-01T12:00:00Z'),
          blockedById: 'user-1',
          blockedBy: { email: 'owner@nextera.local' },
          _count: { held: 0 },
        }),
      ] as never);
      prisma.$queryRaw.mockResolvedValue([]);
      prisma.turbine.findMany.mockResolvedValue([
        { turbineId: 'TURB005', farmId: 'FARM01' },
      ] as never);
      prisma.farm.findMany.mockResolvedValue([farmRef] as never);

      const result = await mcp.call('list_unallocated', {
        status: 'blocked',
        turbineId: 'TURB005',
      });

      expect(prisma.unallocatedTurbine.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'blocked', turbineId: 'TURB005' },
        }),
      );
      expect(result.text).not.toContain('owner@nextera.local');
      expect(result.json().entries[0]).toMatchObject({
        kind: 'farm_mismatch',
        status: 'blocked',
        reportedFarm: null,
        currentFarm: farmRef,
        heldCount: 0,
        latest: null,
        blockedAt: '2026-01-01T12:00:00.000Z',
      });
      expect(result.json().entries[0]).not.toHaveProperty('blockedBy');
    });

    it('get_unallocated_readings: the entry and its held readings by column', async () => {
      prisma.unallocatedTurbine.findMany.mockResolvedValue([
        entryRow(),
      ] as never);
      prisma.$queryRaw.mockResolvedValue([heldRow]);
      prisma.turbine.findMany.mockResolvedValue([]);
      prisma.farm.findMany.mockResolvedValue([farmRef] as never);
      prisma.unallocatedTurbine.findUnique.mockResolvedValue({
        id: ENTRY_ID,
      } as never);
      prisma.heldTelemetry.findMany.mockResolvedValue([
        {
          id: 'h1',
          unallocatedId: ENTRY_ID,
          turbineId: 'TURB099',
          farmId: 'FARM01',
          timestamp: new Date('2026-01-01T23:55:00Z'),
          receivedAt: new Date('2026-01-01T23:55:30Z'),
          createdAt: new Date('2026-01-01T23:55:30Z'),
          powerOutputKw: 1500,
          windSpeedMs: 9,
          rotorRpm: 12,
          bladePitchDeg: 2,
          gearboxTempC: 60,
        },
      ]);

      const result = (
        await mcp.call('get_unallocated_readings', { id: ENTRY_ID, limit: 5 })
      ).json();

      expect(prisma.heldTelemetry.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { unallocatedId: ENTRY_ID },
          take: 5,
        }),
      );
      expect(result).toMatchObject({
        entry: { id: ENTRY_ID, turbineId: 'TURB099', heldCount: 72 },
        count: 1,
        columns: [
          'timestamp',
          'powerOutputKw',
          'windSpeedMs',
          'rotorRpm',
          'bladePitchDeg',
          'gearboxTempC',
        ],
        rows: [['2026-01-01T23:55:00.000Z', 1500, 9, 12, 2, 60]],
      });
    });

    it('get_unallocated_readings reports an unknown entry as an error result', async () => {
      prisma.unallocatedTurbine.findMany.mockResolvedValue([]);

      expect(
        await mcp.call('get_unallocated_readings', { id: ENTRY_ID }),
      ).toMatchObject({
        isError: true,
        text: `Unallocated turbine ${ENTRY_ID} not found`,
      });
      expect(prisma.heldTelemetry.findMany).not.toHaveBeenCalled();
    });

    it('get_turbine points an unknown but reporting turbine to list_unallocated', async () => {
      prisma.turbine.findUnique.mockResolvedValue(null);
      prisma.unallocatedTurbine.findMany.mockResolvedValue([
        entryRow(),
      ] as never);
      prisma.$queryRaw.mockResolvedValue([]);
      prisma.turbine.findMany.mockResolvedValue([]);
      prisma.farm.findMany.mockResolvedValue([farmRef] as never);

      expect(
        await mcp.call('get_turbine', { turbineId: 'TURB099' }),
      ).toMatchObject({
        isError: true,
        text:
          'Turbine TURB099 not found. It is reporting but is not in the fleet: its readings ' +
          'are held (72 readings reporting farm FARM01); see list_unallocated with turbineId ' +
          '"TURB099"',
      });
      expect(prisma.unallocatedTurbine.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'pending', turbineId: 'TURB099' },
        }),
      );
    });

    it('get_turbine lists the pending entries of a turbine reporting another farm', async () => {
      prisma.turbine.findUnique.mockResolvedValue({
        ...turbineRow('TURB003'),
        farm: {
          id: 'FARM01',
          name: 'Prairie Ridge',
          latitude: new Prisma.Decimal('41.25'),
          longitude: new Prisma.Decimal('-96.53'),
        },
      } as never);
      prisma.telemetry.findFirst.mockResolvedValue(null);
      prisma.unallocatedTurbine.findMany.mockResolvedValue([
        entryRow({ turbineId: 'TURB003', reportedFarmId: 'FARM02' }),
      ] as never);
      prisma.$queryRaw.mockResolvedValue([]);
      prisma.turbine.findMany.mockResolvedValue([
        { turbineId: 'TURB003', farmId: 'FARM01' },
      ] as never);
      prisma.farm.findMany.mockResolvedValue([farmRef] as never);

      const result = (
        await mcp.call('get_turbine', { turbineId: 'TURB003' })
      ).json();

      expect(result).toMatchObject({
        id: 'TURB003',
        farm: { id: 'FARM01' },
        status: 'no-data',
        pendingUnallocated: [
          {
            id: ENTRY_ID,
            reportedFarmId: 'FARM02',
            heldCount: 72,
            lastSeenAt: '2026-01-01T23:55:30.000Z',
          },
        ],
      });
    });
  });
});
