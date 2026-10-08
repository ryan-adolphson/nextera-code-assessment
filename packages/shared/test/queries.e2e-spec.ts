import { fileURLToPath } from 'node:url';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client.js';
import { seedFromCsv } from '../src/seed/seed-from-csv.js';
import {
  QueryInputError,
  QueryNotFoundError,
  alertsInRange,
  getTurbine,
  listAlertRules,
  listFarms,
  reportSummary,
  reportTelemetry,
  telemetryStats,
  turbineTelemetry,
} from '../src/wind/queries.js';
import { storeAlerts } from '../src/wind/store-telemetry.js';
import { openMigrationDb, type MigrationDb } from './migration-db.js';

const DATA_DIR = fileURLToPath(new URL('../prisma/data', import.meta.url));
const DAYS = { from: '2026-01-01T00:00:00Z', to: '2026-01-03T00:00:00Z' };

/**
 * The shared read queries against a migrated database of their own, seeded with the fixture CSVs
 * (TURB001/TURB002, 2 days) and the alerts ingestion would have stored for three rules.
 */
describe('read queries (e2e, CSV fixture)', () => {
  let m: MigrationDb;
  let prisma: PrismaClient;

  beforeAll(async () => {
    m = await openMigrationDb('99999999999999_read_queries');
    await m.migrateAll();
    prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString: m.url }),
    });
    await seedFromCsv(prisma, DATA_DIR);
    await prisma.alertConfig.createMany({
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
        {
          // Disabled: never evaluated, so it flags nothing.
          measurementMetric: 'powerOutputKw',
          comparison: 'below',
          valueMetric: 100,
          alertLevel: 'warn',
          enabled: false,
        },
      ],
    });
    // What ingestion stores: each reading's triggered enabled rules.
    const rules = await prisma.alertConfig.findMany({
      where: { enabled: true },
    });
    await storeAlerts(prisma, await prisma.telemetry.findMany(), rules);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
    await m?.close();
  });

  it('listFarms: every farm, its turbines and each turbine’s latest reading', async () => {
    const farms = await listFarms(prisma);

    expect(farms).toHaveLength(10);
    const turbines = farms.flatMap((f) => f.turbines);
    expect(turbines.map((t) => t.id).sort()).toEqual(['TURB001', 'TURB002']);
    for (const turbine of turbines) {
      expect(turbine.latest?.turbineId).toBe(turbine.id);
      const [newest] = await turbineTelemetry(prisma, turbine.id, { limit: 1 });
      expect(turbine.latest).toEqual(newest);
    }
  });

  it('getTurbine: the farm and the same latest reading as listFarms', async () => {
    const turbine = await getTurbine(prisma, 'TURB002');
    const fromOverview = (await listFarms(prisma))
      .flatMap((f) => f.turbines)
      .find((t) => t.id === 'TURB002');

    expect(turbine.farm.id).toBe(turbine.farmId);
    expect(turbine.latest).toEqual(fromOverview!.latest);
    await expect(getTurbine(prisma, 'TURB999')).rejects.toBeInstanceOf(
      QueryNotFoundError,
    );
  });

  it('turbineTelemetry and telemetryStats cover the same rows', async () => {
    const window = {
      from: '2026-01-02T03:00:00Z',
      to: '2026-01-02T04:00:00Z',
      limit: 288,
    };
    const readings = await turbineTelemetry(prisma, 'TURB002', window);
    const stats = await telemetryStats(prisma, 'TURB002', window);

    expect(readings.length).toBe(12);
    expect(stats.count).toBe(readings.length);
    expect(stats.from).toBe(readings.at(-1)!.timestamp);
    expect(stats.to).toBe(readings[0].timestamp);
    // The gearbox stuck at 126.5 °C (03:20–03:30).
    expect(stats.metrics.gearboxTempC!.high).toBe(126.5);
    expect(
      readings
        .filter((r) => r.gearboxTempC === 126.5)
        .map((r) => r.alerts[0].alertLevel),
    ).toEqual(['error', 'error', 'error']);
  });

  it('alertsInRange: the fixture anomalies the enabled rules flag, by turbine, newest first', async () => {
    const alerts = await alertsInRange(prisma, DAYS);

    expect(
      alerts.map((r) => [
        r.turbineId,
        r.timestamp,
        r.alerts.map((a) => a.alertLevel),
      ]),
    ).toEqual([
      ['TURB002', '2026-01-02T03:30:00.000Z', ['error']],
      ['TURB002', '2026-01-02T03:25:00.000Z', ['error']],
      ['TURB002', '2026-01-02T03:20:00.000Z', ['error']],
      ['TURB002', '2026-01-01T18:10:00.000Z', ['info']], // the 44° pitch spike
    ]);
    await expect(
      alertsInRange(prisma, { from: DAYS.to, to: DAYS.from }),
    ).rejects.toBeInstanceOf(QueryInputError);
  });

  it('listAlertRules: all rules, or only the enabled ones', async () => {
    expect(await listAlertRules(prisma)).toHaveLength(3);
    expect(
      (await listAlertRules(prisma, { includeDisabled: false })).map(
        (r) => r.measurementMetric,
      ),
    ).toEqual(['bladePitchDeg', 'gearboxTempC']); // telemetry column order
  });

  it('reportSummary matches reportTelemetry’s rows, aggregated in Postgres', async () => {
    const query = { turbineId: 'TURB002', ...DAYS };
    const report = await reportTelemetry(prisma, query);
    const summary = await reportSummary(prisma, query);
    const gearbox = report.readings.map((r) => r.gearboxTempC);
    const power = report.readings.map((r) => r.powerOutputKw);

    expect(summary.scope).toEqual(report.scope);
    expect(summary.count).toBe(report.readings.length);
    expect(summary.firstTimestamp).toBe(report.readings[0].timestamp);
    expect(summary.lastTimestamp).toBe(report.readings.at(-1)!.timestamp);
    expect(summary.metrics.gearboxTempC).toEqual({
      low: Math.min(...gearbox),
      avg: expect.closeTo(gearbox.reduce((a, b) => a + b) / gearbox.length, 6),
      high: Math.max(...gearbox),
    });
    expect(summary.metrics.powerOutputKw!.low).toBe(Math.min(...power));
    expect(summary.flaggedReadings).toBe(4);
    expect(summary.alertsByLevel).toEqual({
      error: { triggers: 3, readings: 3 },
      warn: { triggers: 0, readings: 0 },
      info: { triggers: 1, readings: 1 },
    });
  });

  it('reportSummary of a farm without readings in the range', async () => {
    const summary = await reportSummary(prisma, {
      farmId: (await getTurbine(prisma, 'TURB001')).farmId,
      from: '2025-01-01T00:00:00Z',
      to: '2025-01-02T00:00:00Z',
    });

    expect(summary).toMatchObject({
      count: 0,
      firstTimestamp: null,
      metrics: { gearboxTempC: null },
      flaggedReadings: 0,
    });
  });
});
