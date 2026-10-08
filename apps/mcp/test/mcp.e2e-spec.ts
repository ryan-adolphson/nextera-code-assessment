import { PrismaPg } from '@prisma/adapter-pg';
import {
  PrismaClient,
  enabledAlertRules,
  seedFromCsv,
  storeAlerts,
} from '@nextera/shared';
import { SEED_DATA_DIR } from '@nextera/testing/seed-data';
import { createReadOnlyPrisma } from '../src/prisma.js';
import { connectClient } from '../src/testing.js';

/** 25 minutes after TURB002's last fixture reading (2026-01-02T23:55Z). */
const NOW = Date.parse('2026-01-03T00:20:00Z');

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
    await writer.$executeRaw`TRUNCATE TABLE telemetry_alerts, alerts_config, telemetry, turbines, farms`;
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

    readOnly = createReadOnlyPrisma(process.env.DATABASE_URL!);
    mcp = await connectClient(readOnly, { now: () => NOW, log: () => {} });
  });

  afterAll(async () => {
    await mcp?.close();
    await readOnly?.$disconnect();
    if (writer) {
      await writer.$executeRaw`TRUNCATE TABLE telemetry_alerts, alerts_config`;
      await writer.$disconnect();
    }
  });

  it('tools/list lists the 7 tools', async () => {
    const { tools } = await mcp.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'get_report_summary',
      'get_telemetry',
      'get_telemetry_stats',
      'get_turbine',
      'list_alert_rules',
      'list_alerts',
      'list_farms',
    ]);
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
    expect(await writer.telemetryAlert.count()).toBe(4);
    expect(await writer.alertConfig.count()).toBe(2);
  });
});
