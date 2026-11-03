import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  enabledAlertRules,
  runFarmRollup,
  seedFromCsv,
  storeAlerts,
} from '@nextera/shared';
import { SEED_DATA_DIR } from '@nextera/testing/seed-data';
import { createReadOnlyPrisma } from '../src/prisma.js';
import { connectClient } from '../src/testing.js';

/** 25 minutes after TURB002's last fixture reading (2026-01-02T23:55Z). */
const NOW = Date.parse('2026-01-03T00:20:00Z');

const HALF_HOUR_MS = 30 * 60 * 1000;

/** 48 hours of FARM02 weather (TURB002's farm) from 2026-01-01T00Z, 96 buckets of 30 minutes. */
const weatherBuckets = Array.from({ length: 96 }, (_, i) => ({
  farmId: 'FARM02',
  time: new Date(Date.parse('2026-01-01T00:00:00Z') + i * HALF_HOUR_MS),
  samples: i === 0 ? 1 : 2,
  windSpeed10mMs: 5 + (i % 4),
  windSpeed80mMs: 8 + (i % 4),
  windDirection10mDeg: 180,
  windDirection80mDeg: 190,
  windGusts10mMs: 12,
  temperature2mC: -2,
  relativeHumidity2mPct: 80,
  surfacePressureHpa: 1012,
  precipitationMm: 0.05,
  cloudCoverPct: i === 0 ? null : 50,
}));

/** A held reading of `turbineId` reporting `farmId`, `minutesBefore` the 2026-01-03 midnight. */
const held = (turbineId: string, farmId: string, minutesBefore: number) => ({
  turbineId,
  farmId,
  timestamp: new Date(
    Date.parse('2026-01-03T00:00:00Z') - minutesBefore * 60_000,
  ),
  receivedAt: new Date(
    Date.parse('2026-01-03T00:00:00Z') - minutesBefore * 60_000 + 30_000,
  ),
  powerOutputKw: 1500,
  windSpeedMs: 9,
  rotorRpm: 12,
  bladePitchDeg: 2,
  gearboxTempC: 60,
});

/**
 * The MCP server over an in-memory transport, on its read-only client, against the Testcontainers
 * Postgres seeded with the fixture CSVs (TURB001/TURB002, 2 days) and the alerts ingestion would
 * have stored for two rules.
 */
describe('Nextera MCP server (e2e, CSV fixture)', () => {
  let writer: PrismaClient;
  let readOnly: PrismaClient;
  let mcp: Awaited<ReturnType<typeof connectClient>>;

  beforeAll(async () => {
    writer = new PrismaClient({
      adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
    });
    await writer.$executeRaw`TRUNCATE TABLE telemetry_alerts, alerts_config, telemetry, turbines, farm_weather, farm_telemetry_rollups, farms, unallocated_turbines, held_telemetry`;
    await seedFromCsv(writer, SEED_DATA_DIR);
    await writer.alertConfig.createMany({
      data: [
        {
          measurementMetric: 'gearboxTempC',
          comparison: 'above',
          valueMetric: 120,
          alertLevel: 'error',
        },
        {
          measurementMetric: 'bladePitchDeg',
          comparison: 'above',
          valueMetric: 30,
          alertLevel: 'info',
        },
      ],
    });
    await storeAlerts(
      writer,
      await writer.telemetry.findMany(),
      await enabledAlertRules(writer),
    );

    await writer.farmWeather.createMany({ data: weatherBuckets });
    await writer.$executeRaw`TRUNCATE TABLE farm_rollup_state, farm_rollup_dirty`;
    await runFarmRollup(writer, {
      mode: { kind: 'full' },
      now: new Date('2026-01-03T00:00:00Z'),
    });
    // Pending: TURB099 isn't in the fleet; TURB001 (on FARM01) reports FARM05. Blocked: TURB097,
    // blocked by a user (whose email the tools must not show).
    const blocker = await writer.user.create({
      data: {
        email: 'blocker@nextera.local',
        passwordHash: 'x',
        role: 'owner',
      },
    });
    for (const [turbineId, farmId, count, lastSeen] of [
      ['TURB099', 'FARM01', 12, '2026-01-03T00:00:30Z'],
      ['TURB001', 'FARM05', 3, '2026-01-02T23:00:30Z'],
    ] as const) {
      await writer.unallocatedTurbine.create({
        data: {
          turbineId,
          reportedFarmId: farmId,
          kind: turbineId === 'TURB099' ? 'unknown_turbine' : 'farm_mismatch',
          firstSeenAt: new Date('2026-01-02T20:00:00Z'),
          lastSeenAt: new Date(lastSeen),
          held: {
            createMany: {
              data: Array.from({ length: count }, (_, i) =>
                held(turbineId, farmId, i * 5),
              ),
            },
          },
        },
      });
    }
    await writer.unallocatedTurbine.create({
      data: {
        turbineId: 'TURB097',
        reportedFarmId: 'FARM05',
        kind: 'unknown_turbine',
        status: 'blocked',
        firstSeenAt: new Date('2026-01-01T00:00:00Z'),
        lastSeenAt: new Date('2026-01-01T06:00:00Z'),
        blockedAt: new Date('2026-01-01T06:00:00Z'),
        blockedById: blocker.id,
      },
    });

    readOnly = createReadOnlyPrisma(process.env.DATABASE_URL!);
    mcp = await connectClient(readOnly, { now: () => NOW, log: () => {} });
  });

  afterAll(async () => {
    await mcp?.close();
    await readOnly?.$disconnect();
    if (writer) {
      await writer.$executeRaw`TRUNCATE TABLE telemetry_alerts, alerts_config, unallocated_turbines, held_telemetry, farm_weather`;
      await writer.user.deleteMany({
        where: { email: 'blocker@nextera.local' },
      });
      await writer.$disconnect();
    }
  });

  it('tools/list lists the 12 tools', async () => {
    const { tools } = await mcp.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_farm_daily',
      'get_report_summary',
      'get_telemetry',
      'get_telemetry_stats',
      'get_turbine',
      'get_unallocated_readings',
      'get_weather',
      'list_alert_rules',
      'list_alerts',
      'list_anomalies',
      'list_farms',
      'list_unallocated',
    ]);
    for (const tool of tools) {
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
  });

  it('rejects an unknown argument instead of answering with the default window', async () => {
    const result = await mcp.call('get_telemetry', {
      turbineId: 'TURB001',
      form: '2026-01-01T13:40:00Z',
    });

    expect(result.isError).toBe(true);
    expect(result.text).toContain('Unrecognized key: "form"');
  });

  it('list_farms: the fixture fleet with each turbine’s status', async () => {
    const result = (await mcp.call('list_farms')).json();

    expect(result.farmCount).toBe(10);
    expect(result.turbineCount).toBe(2);
    const turbines = result.farms.flatMap(
      (f: { turbines: unknown[] }) => f.turbines,
    );
    expect(turbines).toEqual([
      expect.objectContaining({
        id: 'TURB001',
        status: expect.any(String),
        latest: expect.objectContaining({ timestamp: expect.any(String) }),
      }),
      expect.objectContaining({
        id: 'TURB002',
        status: 'stale-15',
        minutesSinceLatest: 25,
        latest: expect.objectContaining({
          timestamp: '2026-01-02T23:55:00.000Z',
        }),
      }),
    ]);
  });

  it('get_turbine: farm, status and latest reading', async () => {
    const result = (
      await mcp.call('get_turbine', { turbineId: 'TURB002' })
    ).json();

    expect(result).toMatchObject({
      id: 'TURB002',
      farm: { id: 'FARM02' },
      status: 'stale-15',
      latest: { timestamp: '2026-01-02T23:55:00.000Z' },
    });
    expect(
      await mcp.call('get_turbine', { turbineId: 'TURB999' }),
    ).toMatchObject({ isError: true, text: 'Turbine TURB999 not found' });
  });

  it('get_turbine: the pending entry of a turbine reporting another farm; an unknown but reporting turbine points to list_unallocated', async () => {
    expect(
      (await mcp.call('get_turbine', { turbineId: 'TURB001' })).json(),
    ).toMatchObject({
      id: 'TURB001',
      farm: { id: 'FARM01' },
      pendingUnallocated: [
        {
          reportedFarmId: 'FARM05',
          heldCount: 3,
          lastSeenAt: '2026-01-02T23:00:30.000Z',
        },
      ],
    });
    expect(
      (await mcp.call('get_turbine', { turbineId: 'TURB002' })).json(),
    ).toMatchObject({ pendingUnallocated: [] });

    const unknown = await mcp.call('get_turbine', { turbineId: 'TURB099' });
    expect(unknown.isError).toBe(true);
    expect(unknown.text).toBe(
      'Turbine TURB099 not found. It is reporting but is not in the fleet: its readings are ' +
        'held (12 readings reporting farm FARM01); see list_unallocated with turbineId "TURB099"',
    );
  });

  it('get_weather: daily (default) aggregates UTC days in Postgres', async () => {
    const result = (
      await mcp.call('get_weather', {
        farmId: 'FARM02',
        from: '2026-01-01T00:00:00Z',
        to: '2026-01-03T00:00:00Z',
      })
    ).json();
    const at = (row: unknown[], column: string) =>
      row[result.columns.indexOf(column)];

    expect(result).toMatchObject({
      farmId: 'FARM02',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-01-03T00:00:00.000Z',
      interval: 'daily',
      timeZone: 'UTC',
      count: 2,
    });
    const [day1, day2] = result.rows;
    expect(at(day1, 'date')).toBe('2026-01-01');
    expect(at(day1, 'samples')).toBe(48);
    expect(at(day1, 'windSpeed80mMeanMs')).toBe(9.5); // 8..11, evenly
    expect(at(day1, 'windSpeed80mMaxMs')).toBe(11);
    expect(at(day1, 'windDirection80mDeg')).toBe(190);
    expect(at(day1, 'precipitationSumMm')).toBe(2.4);
    expect(at(day2, 'date')).toBe('2026-01-02');
  });

  it('get_weather: a turbine gets its farm’s weather; local days in timeZone', async () => {
    const result = (
      await mcp.call('get_weather', {
        turbineId: 'TURB002',
        from: '2026-01-01T00:00:00Z',
        to: '2026-01-03T00:00:00Z',
        timeZone: 'America/Chicago',
      })
    ).json();

    expect(result).toMatchObject({
      farmId: 'FARM02',
      turbineId: 'TURB002',
      timeZone: 'America/Chicago',
      interval: 'daily',
    });
    // CST (−6): 2025-12-31 gets the first 6 h, 2026-01-02 runs to 18:00 local.
    expect(result.rows.map((row: unknown[]) => [row[0], row[1]])).toEqual([
      ['2025-12-31', 12],
      ['2026-01-01', 48],
      ['2026-01-02', 36],
    ]);
  });

  it('get_weather: 30-minute rows in [from, to), oldest first', async () => {
    const result = (
      await mcp.call('get_weather', {
        farmId: 'FARM02',
        from: '2026-01-01T00:00:00Z',
        to: '2026-01-01T01:30:00Z',
        interval: '30min',
      })
    ).json();

    expect(result).toMatchObject({ interval: '30min', count: 3 });
    expect(result.rows.map((row: unknown[]) => [row[0], row[1]])).toEqual([
      ['2026-01-01T00:00:00.000Z', 1],
      ['2026-01-01T00:30:00.000Z', 2],
      ['2026-01-01T01:00:00.000Z', 2],
    ]);
    expect(result.rows[0].at(-1)).toBeNull(); // cloud cover not reported
  });

  it('get_weather: an unknown farm or turbine, a long range, a bad zone, both ids, and a farm without weather', async () => {
    const day = { from: '2026-01-01T00:00:00Z', to: '2026-01-02T00:00:00Z' };
    expect(
      await mcp.call('get_weather', { farmId: 'FARM99', ...day }),
    ).toMatchObject({ isError: true, text: 'Farm FARM99 not found' });
    expect(
      await mcp.call('get_weather', { turbineId: 'TURB999', ...day }),
    ).toMatchObject({ isError: true, text: 'Turbine TURB999 not found' });
    expect(
      await mcp.call('get_weather', {
        farmId: 'FARM02',
        from: '2026-01-01T00:00:00Z',
        to: '2026-02-01T00:00:01Z',
      }),
    ).toMatchObject({
      isError: true,
      text: 'The range may span at most 31 days',
    });
    expect(
      await mcp.call('get_weather', {
        farmId: 'FARM02',
        ...day,
        timeZone: 'Mars/Olympus',
      }),
    ).toMatchObject({
      isError: true,
      text: 'timeZone must be an IANA time zone name, e.g. "America/Chicago" (default "UTC")',
    });
    const both = await mcp.call('get_weather', {
      farmId: 'FARM02',
      turbineId: 'TURB002',
      ...day,
    });
    expect(both.isError).toBe(true);
    expect(both.text).toContain('Provide exactly one of farmId or turbineId');
    const none = await mcp.call('get_weather', { farmId: 'FARM01', ...day });
    expect(none.isError).toBe(false);
    expect(none.json()).toMatchObject({ count: 0, rows: [] });
  });

  it('get_farm_daily: daily candles of the fixture from the rollups, through the read-only client', async () => {
    const result = await mcp.call('get_farm_daily', {
      farmId: 'FARM02',
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-03T00:00:00Z',
    });

    expect(result.isError).toBe(false);
    const body = result.json();
    expect(body).toMatchObject({
      farmId: 'FARM02',
      timeZone: 'UTC',
      turbineCount: 1,
      computedAt: expect.any(String),
    });
    expect(body.days.map((d: { date: string }) => d.date)).toEqual([
      '2026-01-01',
      '2026-01-02',
    ]);
    // TURB002's pitch spike (44° at 2026-01-01 18:10) and stuck gearbox (126.5 °C on 2026-01-02).
    expect(body.days[0].bladePitchDeg.high).toBe(44);
    expect(body.days[1].gearboxTempC.high).toBe(126.5);
    const unknown = await mcp.call('get_farm_daily', {
      farmId: 'FARM99',
      from: '2026-01-01T00:00:00Z',
      to: '2026-01-03T00:00:00Z',
    });
    expect(unknown).toMatchObject({
      isError: true,
      text: 'Farm FARM99 not found',
    });
  });

  it('list_unallocated: pending by latest activity, blocked without the blocking user', async () => {
    const pending = (await mcp.call('list_unallocated')).json();
    expect(pending).toMatchObject({
      asOf: '2026-01-03T00:20:00.000Z',
      status: 'pending',
      count: 2,
      entries: [
        {
          turbineId: 'TURB099',
          kind: 'unknown_turbine',
          reportedFarm: { id: 'FARM01' },
          currentFarm: null,
          heldCount: 12,
          minutesSinceLastSeen: 19,
          latest: { timestamp: '2026-01-03T00:00:00.000Z' },
        },
        {
          turbineId: 'TURB001',
          kind: 'farm_mismatch',
          reportedFarm: { id: 'FARM05' },
          currentFarm: { id: 'FARM01' },
          heldCount: 3,
        },
      ],
    });

    const blocked = await mcp.call('list_unallocated', { status: 'blocked' });
    expect(blocked.json()).toMatchObject({
      count: 1,
      entries: [
        {
          turbineId: 'TURB097',
          status: 'blocked',
          heldCount: 0,
          latest: null,
          blockedAt: '2026-01-01T06:00:00.000Z',
        },
      ],
    });
    expect(blocked.text).not.toContain('blocker@nextera.local');

    expect(
      (await mcp.call('list_unallocated', { turbineId: 'TURB001' })).json(),
    ).toMatchObject({ count: 1, entries: [{ reportedFarmId: 'FARM05' }] });
  });

  it('get_unallocated_readings: newest first, at most limit; an unknown id is an error', async () => {
    const [entry] = (
      await mcp.call('list_unallocated', { turbineId: 'TURB099' })
    ).json().entries;

    const result = (
      await mcp.call('get_unallocated_readings', { id: entry.id, limit: 2 })
    ).json();
    expect(result).toMatchObject({
      entry: { id: entry.id, turbineId: 'TURB099', heldCount: 12 },
      count: 2,
      rows: [
        ['2026-01-03T00:00:00.000Z', 1500, 9, 12, 2, 60],
        ['2026-01-02T23:55:00.000Z', 1500, 9, 12, 2, 60],
      ],
    });

    const missing = '00000000-0000-4000-8000-000000000000';
    expect(
      await mcp.call('get_unallocated_readings', { id: missing }),
    ).toMatchObject({
      isError: true,
      text: `Unallocated turbine ${missing} not found`,
    });
  });

  it('list_anomalies finds the fixture TURB001 stop (the short TURB002 gearbox fault is too short to be stuck)', async () => {
    const result = (
      await mcp.call('list_anomalies', {
        from: '2026-01-01T00:00:00Z',
        to: '2026-01-03T00:00:00Z',
      })
    ).json();

    expect(result.anomalies).toContainEqual(
      expect.objectContaining({
        turbineId: 'TURB001',
        kind: 'low_power_in_wind',
        start: '2026-01-01T13:40:00.000Z',
        end: '2026-01-01T13:50:00.000Z',
        readings: 3,
      }),
    );
    // TURB002's 3-reading stuck gearbox is under the 12 readings a stuck sensor needs.
    expect(result.anomalies).toHaveLength(1);
    expect(result.totalEpisodes).toBe(result.anomalies.length);
    expect(result.estimatedLostKwh).toBeGreaterThan(0);
  });

  it('list_alerts finds the fixture anomalies the rules flag', async () => {
    const result = (
      await mcp.call('list_alerts', {
        from: '2026-01-01T00:00:00Z',
        to: '2026-01-03T00:00:00Z',
      })
    ).json();

    expect(result).toMatchObject({ flaggedReadings: 4, turbineCount: 1 });
    expect(result.turbines[0]).toMatchObject({
      turbineId: 'TURB002',
      worstLevel: 'error',
      levelCounts: { error: 3, warn: 0, info: 1 },
      latestAlert: '2026-01-02T03:30:00.000Z',
      readings: [
        {
          timestamp: '2026-01-02T03:30:00.000Z',
          alerts: ['error: gearboxTempC 126.5 above 120'],
        },
        {
          timestamp: '2026-01-02T03:25:00.000Z',
          alerts: ['error: gearboxTempC 126.5 above 120'],
        },
        {
          timestamp: '2026-01-02T03:20:00.000Z',
          alerts: ['error: gearboxTempC 126.5 above 120'],
        },
        {
          timestamp: '2026-01-01T18:10:00.000Z',
          alerts: ['info: bladePitchDeg 44 above 30'],
        },
      ],
    });
  });

  it('get_telemetry_stats covers exactly the rows get_telemetry returns', async () => {
    const window = {
      turbineId: 'TURB001',
      from: '2026-01-01T12:00:00Z',
      to: '2026-01-01T15:00:00Z', // TURB001's stop at 13:40–13:50
    };
    const telemetry = (await mcp.call('get_telemetry', window)).json();
    const stats = (await mcp.call('get_telemetry_stats', window)).json();
    const column = (name: string) =>
      telemetry.rows.map(
        (row: unknown[]) => row[telemetry.columns.indexOf(name)] as number,
      );
    const median = (values: number[]) => {
      const sorted = [...values].sort((a, b) => a - b);
      const mid = sorted.length / 2;
      return Number.isInteger(mid)
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[Math.floor(mid)];
    };

    expect(telemetry.count).toBe(36);
    expect(stats).toMatchObject({
      turbineId: 'TURB001',
      count: 36,
      from: telemetry.rows.at(-1)[0],
      to: telemetry.rows[0][0],
    });
    for (const metric of [
      'powerOutputKw',
      'windSpeedMs',
      'rotorRpm',
      'bladePitchDeg',
      'gearboxTempC',
    ]) {
      const values = column(metric);
      expect(stats.metrics[metric].median).toBeCloseTo(median(values), 6);
      expect(stats.metrics[metric].high).toBe(Math.max(...values));
      expect(stats.metrics[metric].low).toBe(Math.min(...values));
    }
    expect(stats.metrics.powerOutputKw.low).toBe(0); // the stop
  });

  it('get_report_summary: a farm over the two fixture days', async () => {
    const result = (
      await mcp.call('get_report_summary', {
        farmId: 'FARM02',
        from: '2026-01-01T00:00:00Z',
        to: '2026-01-03T00:00:00Z',
      })
    ).json();

    expect(result).toMatchObject({
      scope: { kind: 'farm', id: 'FARM02', farmId: 'FARM02' },
      flaggedReadings: 4,
      alertsByLevel: { error: { triggers: 3 }, info: { triggers: 1 } },
      metrics: { gearboxTempC: { high: 126.5 }, bladePitchDeg: { high: 44 } },
    });
    expect(result.count).toBeGreaterThan(500);
  });

  it('list_alert_rules lists the rules', async () => {
    const rules = (await mcp.call('list_alert_rules')).json();
    expect(
      rules.map((r: { measurementMetric: string }) => r.measurementMetric),
    ).toEqual(['bladePitchDeg', 'gearboxTempC']);
  });

  it('the server’s client cannot write: Postgres rejects it with 25006', async () => {
    const write = readOnly.alertConfig.create({
      data: {
        measurementMetric: 'rotorRpm',
        comparison: 'above',
        valueMetric: 20,
        alertLevel: 'warn',
      },
    });
    await expect(write).rejects.toThrow(/read-only transaction/);
    const error = await write.catch((e: unknown) => e);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).toContain(
      '25006',
    );

    await expect(
      readOnly.$executeRaw`DELETE FROM telemetry_alerts`,
    ).rejects.toThrow(/read-only transaction/);
    await expect(readOnly.farmWeather.deleteMany({})).rejects.toThrow(
      /read-only transaction/,
    );
    await expect(
      readOnly.unallocatedTurbine.updateMany({ data: { status: 'blocked' } }),
    ).rejects.toThrow(/read-only transaction/);
    expect(await writer.farmWeather.count()).toBe(96);
    expect(
      await writer.unallocatedTurbine.count({ where: { status: 'pending' } }),
    ).toBe(2);
    expect(await writer.telemetryAlert.count()).toBe(4);
    expect(await writer.alertConfig.count()).toBe(2);
  });
});
