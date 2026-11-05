import { randomUUID } from 'node:crypto';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { PrismaService } from '@nextera/shared';

const reading = (minute: number) => ({
  turbine_id: 'TURB001',
  farm_id: 'FARM01',
  timestamp: new Date(Date.UTC(2026, 1, 28, 0, minute)).toISOString(),
  power_output_kw: 2000,
  wind_speed_ms: 8,
  rotor_rpm: 14,
  blade_pitch_deg: 3,
  gearbox_temp_c: 126.5,
});

const push = (url: string, payload: unknown) =>
  fetch(`${url}/pubsub/telemetry`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      subscription: 'projects/nextera-local/subscriptions/telemetry-ingestion',
      message: {
        messageId: randomUUID(),
        publishTime: '2026-03-01T00:01:30Z',
        data: Buffer.from(JSON.stringify(payload)).toString('base64'),
      },
    }),
  });

/**
 * The enabled alert rules are cached for ALERT_RULES_CACHE_TTL_MS: a rule created after the cache
 * loaded is applied to new readings once the TTL has passed (here 30 s, with the clock moved), not
 * before. The other e2e specs run with the cache off.
 */
describe('Ingestion alert rules cache (e2e)', () => {
  let app: NestExpressApplication;
  let url: string;
  let prisma: PrismaService;

  beforeAll(async () => {
    process.env.ALERT_RULES_CACHE_TTL_MS = '30000';
    const { createTestApp } = await import('./helpers.js');
    ({ app, url, prisma } = await createTestApp());
  });

  afterAll(async () => {
    vi.useRealTimers();
    await app.close();
  });

  beforeEach(async () => {
    await prisma.$executeRaw`TRUNCATE TABLE turbine_latest, telemetry_alerts, telemetry, alerts_config`;
  });

  it('applies a new rule to readings once the TTL has passed', async () => {
    vi.useFakeTimers({
      toFake: ['Date'],
      now: new Date('2026-03-01T00:00:00Z'),
    });

    // The first reading loads the (empty) rules.
    expect((await push(url, reading(0))).status).toBe(204);
    await prisma.alertConfig.create({
      data: {
        measurementMetric: 'gearboxTempC',
        comparison: 'above',
        valueMetric: 120,
        alertLevel: 'error',
      },
    });

    // 29 s later the cache is still warm: the new rule is not applied yet.
    vi.setSystemTime(new Date('2026-03-01T00:00:29Z'));
    expect((await push(url, reading(5))).status).toBe(204);
    expect(await prisma.telemetryAlert.count()).toBe(0);

    // After the TTL it reads the rules again.
    vi.setSystemTime(new Date('2026-03-01T00:00:31Z'));
    expect((await push(url, reading(10))).status).toBe(204);
    expect(await prisma.telemetryAlert.count()).toBe(1);
    expect(
      (
        await prisma.turbineLatest.findUniqueOrThrow({
          where: { turbineId: 'TURB001' },
        })
      ).worstAlertLevel,
    ).toBe('error');
  });

  it('survives a rule deleted while it is cached: the failed batch drops the cache and the retry succeeds', async () => {
    vi.useFakeTimers({
      toFake: ['Date'],
      now: new Date('2026-03-01T01:00:00Z'),
    });
    const rule = await prisma.alertConfig.create({
      data: {
        measurementMetric: 'gearboxTempC',
        comparison: 'above',
        valueMetric: 120,
        alertLevel: 'error',
      },
    });
    vi.setSystemTime(new Date('2026-03-01T01:01:00Z')); // past the previous test's cache
    expect((await push(url, reading(20))).status).toBe(204); // loads the rule: one alert
    expect(await prisma.telemetryAlert.count()).toBe(1);

    // Delete the rule (its alert goes first: RESTRICT) while the worker still has it cached.
    await prisma.$executeRaw`TRUNCATE TABLE telemetry_alerts`;
    await prisma.alertConfig.delete({ where: { id: rule.id } });

    vi.setSystemTime(new Date('2026-03-01T01:01:10Z')); // still within the TTL
    const res = await push(url, reading(25));
    // The batch fails on the alert's foreign key, the cache is dropped and the single retry reads
    // no rules: stored without alerts, acked.
    expect(res.status).toBe(204);
    expect(
      await prisma.telemetry.count({
        where: { timestamp: new Date('2026-02-28T00:25:00Z') },
      }),
    ).toBe(1);
    expect(await prisma.telemetryAlert.count()).toBe(0);
  });
});
