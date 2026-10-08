import { fileURLToPath } from 'node:url';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import type {
  AlertConfig,
  Prisma,
  PrismaClient,
  Telemetry,
} from '../generated/prisma/client.js';
import { DEMO_ALERT_RULES, DEMO_TURBINES } from './demo-fleet.js';
import { DEMO_ANOMALIES } from './generate-telemetry.js';
import { parseDemoSeedEnv, seedDemo } from './seed-demo.js';

const DATA_DIR = fileURLToPath(new URL('../../prisma/data', import.meta.url));
const END = new Date('2026-10-08T12:02:00Z'); // floored to 12:00
const HOUR = 3_600_000;

const rules: AlertConfig[] = DEMO_ALERT_RULES.map((r, i) => ({
  ...r,
  id: `rule-${i}`,
  enabled: true,
}));

describe('seedDemo', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let stored: Set<string>;

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
    prisma.alertConfig.createMany.mockResolvedValue({ count: 2 });
    prisma.alertConfig.findMany.mockResolvedValue(rules);
    prisma.telemetryAlert.createMany.mockResolvedValue({ count: 0 });
    // A fake telemetry table: unique (turbine_id, timestamp), ON CONFLICT DO NOTHING.
    stored = new Set();
    prisma.telemetry.createManyAndReturn.mockImplementation(((args: {
      data: Prisma.TelemetryCreateManyInput[];
    }) =>
      Promise.resolve(
        args.data.flatMap((row): Telemetry[] => {
          const key = `${row.turbineId}@${(row.timestamp as Date).toISOString()}`;
          if (stored.has(key)) return [];
          stored.add(key);
          return [
            { ...row, id: key, createdAt: new Date() } as unknown as Telemetry,
          ];
        }),
      )) as never);
    prisma.$transaction.mockImplementation((fn: unknown) =>
      (fn as (tx: PrismaClient) => Promise<unknown>)(prisma),
    );
  });

  const run = (end = END, hours = 72) =>
    seedDemo(prisma, { dataDir: DATA_DIR, end, hours });
  const links = () =>
    prisma.telemetryAlert.createMany.mock.calls.flatMap(
      ([args]) => args?.data as Prisma.TelemetryAlertCreateManyInput[],
    );

  it('upserts the fixture farms and the demo turbines (commissioned only on create)', async () => {
    await run();

    expect(prisma.farm.upsert).toHaveBeenCalledTimes(10);
    expect(prisma.turbine.upsert).toHaveBeenCalledTimes(DEMO_TURBINES.length);
    const [args] = prisma.turbine.upsert.mock.calls.find(
      ([a]) => a.where.turbineId === 'TURB001',
    )!;
    expect(args.create).toEqual({
      turbineId: 'TURB001',
      farmId: 'FARM01',
      latitude: 41.263,
      longitude: -96.518,
      commissioned: false,
    });
    expect(args.update).toEqual({
      farmId: 'FARM01',
      latitude: 41.263,
      longitude: -96.518,
    });
  });

  it('creates only the missing default rules and evaluates the enabled ones', async () => {
    const result = await run();

    expect(prisma.alertConfig.createMany).toHaveBeenCalledWith({
      data: DEMO_ALERT_RULES,
      skipDuplicates: true,
    });
    expect(prisma.alertConfig.update).not.toHaveBeenCalled();
    expect(prisma.alertConfig.upsert).not.toHaveBeenCalled();
    expect(prisma.alertConfig.findMany).toHaveBeenCalledWith({
      where: { enabled: true },
    });
    expect(result).toMatchObject({ rulesCreated: 2, rulesEvaluated: 3 });
  });

  it('inserts in batched transactions and links exactly the anomalies to the rules they trigger', async () => {
    const result = await run();

    const calls = prisma.telemetry.createManyAndReturn.mock.calls;
    expect(calls.length).toBe(Math.ceil(result.rows / 1000));
    expect(prisma.$transaction).toHaveBeenCalledTimes(calls.length);
    expect(calls.every(([a]) => a?.skipDuplicates === true)).toBe(true);
    expect(result).toMatchObject({
      inserted: result.rows,
      skipped: 0,
      alerts: 7,
      from: '2026-10-05T12:05:00.000Z',
      to: '2026-10-08T12:00:00.000Z',
    });

    const at = (turbineId: string, minutesBeforeEnd: number) =>
      `${turbineId}@${new Date(Date.parse('2026-10-08T12:00:00Z') - minutesBeforeEnd * 60_000).toISOString()}`;
    const { frozenPower, pitchSpike, gearboxStuck } = DEMO_ANOMALIES;
    const expected = [
      ...[0, 5, 10].map((m) => ({
        telemetryId: at('TURB001', frozenPower.offsetMinutes - m),
        alertId: 'rule-1', // power below 100 → warn
      })),
      {
        telemetryId: at('TURB002', pitchSpike.offsetMinutes),
        alertId: 'rule-2', // pitch above 30 → info
      },
      ...[0, 5, 10].map((m) => ({
        telemetryId: at('TURB002', gearboxStuck.offsetMinutes - m),
        alertId: 'rule-0', // gearbox above 100 → error
      })),
    ];
    expect(links()).toHaveLength(expected.length);
    expect(links()).toEqual(expect.arrayContaining(expected));
  });

  it('is idempotent: a re-run inserts nothing, a later one tops up to the new end', async () => {
    const first = await run();
    prisma.telemetryAlert.createMany.mockClear();

    const again = await run();
    expect(again).toMatchObject({
      inserted: 0,
      skipped: first.rows,
      alerts: 0,
    });
    expect(prisma.telemetryAlert.createMany).not.toHaveBeenCalled();

    const later = await run(new Date(END.getTime() + HOUR));
    // 12 new steps for each turbine (the stopped one's window moves too), plus the earlier gap,
    // which is no longer at the gap's offset.
    expect(later.inserted).toBe(
      DEMO_TURBINES.length * 12 + DEMO_ANOMALIES.gap.readings,
    );
    expect(later.to).toBe('2026-10-08T13:00:00.000Z');
  });

  it('evaluates no rules when all are disabled or none exist', async () => {
    prisma.alertConfig.findMany.mockResolvedValue([]);
    const result = await run(END, 1);
    expect(result.alerts).toBe(0);
    expect(prisma.telemetryAlert.createMany).not.toHaveBeenCalled();
  });

  it('stops on an insert failure', async () => {
    prisma.$transaction.mockRejectedValueOnce(new Error('db down'));
    await expect(run()).rejects.toThrow('db down');
  });
});

describe('parseDemoSeedEnv', () => {
  const now = new Date('2026-10-08T12:34:56Z');

  it('defaults to now and 72 hours', () => {
    expect(parseDemoSeedEnv({}, now)).toEqual({ end: now, hours: 72 });
  });

  it('reads SEED_NOW and SEED_HOURS', () => {
    expect(
      parseDemoSeedEnv(
        { SEED_NOW: '2026-01-03T00:00:00Z', SEED_HOURS: '24' },
        now,
      ),
    ).toEqual({ end: new Date('2026-01-03T00:00:00Z'), hours: 24 });
  });

  it.each([
    [{ SEED_NOW: 'yesterday' }, /SEED_NOW/],
    [{ SEED_NOW: '2026-01-03' }, /SEED_NOW/],
    [{ SEED_NOW: '2026-02-30T00:00:00Z' }, /SEED_NOW/],
    [{ SEED_HOURS: '0' }, /SEED_HOURS/],
    [{ SEED_HOURS: '1.5' }, /SEED_HOURS/],
    [{ SEED_HOURS: '10000' }, /SEED_HOURS/],
  ])('rejects %o', (env, message) => {
    expect(() => parseDemoSeedEnv(env, now)).toThrow(message);
  });
});
