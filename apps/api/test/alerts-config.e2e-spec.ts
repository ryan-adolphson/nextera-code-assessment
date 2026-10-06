import { createTestApp, type TestApp } from './helpers.js';

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The alerts_config table and its enums, against the migrated Postgres. */
describe('alerts_config (e2e, real Postgres)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  beforeEach(async () => {
    await t.prisma.$executeRaw`TRUNCATE TABLE alerts_config`;
  });

  it('stores a threshold through Prisma with a database-generated UUID v4', async () => {
    const row = await t.prisma.alertConfig.create({
      data: {
        measurementMetric: 'gearboxTempC',
        comparison: 'above',
        valueMetric: 120.5,
        alertLevel: 'error',
      },
    });

    expect(row).toMatchObject({
      measurementMetric: 'gearboxTempC',
      comparison: 'above',
      valueMetric: 120.5,
      alertLevel: 'error',
    });
    expect(row.id).toMatch(UUID_V4);
  });

  it('stores the telemetry column names as the metric enum values in Postgres', async () => {
    const [row] = await t.prisma.$queryRaw<
      { id: string; measurement_metric: string }[]
    >`
      INSERT INTO alerts_config (measurement_metric, comparison, value_metric, alert_level)
      VALUES ('power_output_kw', 'below', 100, 'info')
      RETURNING id::text, measurement_metric::text`;

    expect(row.id).toMatch(UUID_V4);
    expect(row.measurement_metric).toBe('power_output_kw');
    const viaPrisma = await t.prisma.alertConfig.findUniqueOrThrow({
      where: { id: row.id },
    });
    expect(viaPrisma.measurementMetric).toBe('powerOutputKw');
  });

  it.each([
    ['an unknown metric', `'not_a_metric'`, `'above'`, `'warn'`],
    ['an unknown comparison', `'rotor_rpm'`, `'equal'`, `'warn'`],
    ['an unknown alert level', `'rotor_rpm'`, `'above'`, `'critical'`],
  ])('rejects %s', async (_case, metric, comparison, level) => {
    await expect(
      t.prisma.$executeRawUnsafe(
        `INSERT INTO alerts_config (measurement_metric, comparison, value_metric, alert_level)
         VALUES (${metric}, ${comparison}, 1, ${level})`,
      ),
    ).rejects.toThrow(/invalid input value for enum/);
  });

  it('requires every column except id', async () => {
    await expect(
      t.prisma.$executeRaw`
        INSERT INTO alerts_config (measurement_metric, comparison, alert_level)
        VALUES ('rotor_rpm', 'above', 'warn')`,
    ).rejects.toThrow(/value_metric/);
  });
});
