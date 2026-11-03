import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import type {
  AlertConfig,
  Prisma,
  Telemetry,
} from '../generated/prisma/client.js';
import {
  insertTelemetryBulk,
  type BulkTelemetryRow,
} from './store-telemetry.js';

const rule: AlertConfig = {
  id: 'rule-hot',
  measurementMetric: 'gearboxTempC',
  comparison: 'above',
  valueMetric: 100,
  alertLevel: 'error',
  enabled: true,
};
const row = (
  minute: number,
  overrides: Partial<BulkTelemetryRow> = {},
): BulkTelemetryRow => ({
  turbineId: 'TURB001',
  farmId: 'FARM01',
  timestamp: new Date(Date.UTC(2026, 9, 8, 12, minute)),
  receivedAt: new Date(Date.UTC(2026, 9, 8, 12, minute, 30)),
  powerOutputKw: 1500,
  windSpeedMs: 9,
  rotorRpm: 14,
  bladePitchDeg: 2,
  gearboxTempC: 80,
  ...overrides,
});

describe('insertTelemetryBulk', () => {
  let tx: DeepMockProxy<Prisma.TransactionClient>;

  beforeEach(() => {
    tx = mockDeep<Prisma.TransactionClient>();
    tx.$queryRaw.mockResolvedValue([{ count: 2 }] as never);
    tx.telemetry.createManyAndReturn.mockImplementation(((args: {
      data: BulkTelemetryRow[];
    }) =>
      Promise.resolve(
        args.data.map((r, i) => ({ ...r, id: `t-${i}` }) as Telemetry),
      )) as never);
    tx.telemetryAlert.createMany.mockResolvedValue({ count: 1 });
  });

  it('bulk-inserts the quiet readings as one array per column and stores the flagged ones with their alerts', async () => {
    const quiet = [row(0), row(5, { turbineId: 'TURB002', farmId: 'FARM02' })];
    const hot = row(10, { gearboxTempC: 126.5 });

    await expect(
      insertTelemetryBulk(tx, [quiet[0], hot, quiet[1]], [rule]),
    ).resolves.toEqual({ inserted: 3, alerts: 1 });

    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    const [sql, ...values] = tx.$queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(sql.join('?')).toMatch(/INSERT INTO telemetry[\s\S]*unnest/);
    expect(sql.join('?')).toMatch(/ON CONFLICT DO NOTHING/);
    expect(values).toEqual([
      ['TURB001', 'TURB002'],
      ['FARM01', 'FARM02'],
      ['2026-10-08T12:00:00.000Z', '2026-10-08T12:05:00.000Z'],
      ['2026-10-08T12:00:30.000Z', '2026-10-08T12:05:30.000Z'],
      [1500, 1500],
      [9, 9],
      [14, 14],
      [2, 2],
      [80, 80],
    ]);
    expect(tx.telemetry.createManyAndReturn).toHaveBeenCalledExactlyOnceWith({
      data: [hot],
      skipDuplicates: true,
    });
    expect(tx.telemetryAlert.createMany).toHaveBeenCalledExactlyOnceWith({
      data: [{ telemetryId: 't-0', alertId: 'rule-hot' }],
    });
  });

  it('counts only new readings (duplicates are skipped by ON CONFLICT DO NOTHING)', async () => {
    tx.$queryRaw.mockResolvedValue([{ count: 0 }] as never);
    await expect(
      insertTelemetryBulk(tx, [row(0), row(5)], [rule]),
    ).resolves.toEqual({ inserted: 0, alerts: 0 });
    expect(tx.telemetry.createManyAndReturn).not.toHaveBeenCalled();
  });

  it('evaluates disabled rules as no rules, and sends nothing for an empty batch', async () => {
    await insertTelemetryBulk(
      tx,
      [row(0, { gearboxTempC: 130 })],
      [{ ...rule, enabled: false }],
    );
    expect(tx.$queryRaw).toHaveBeenCalledOnce();
    expect(tx.telemetry.createManyAndReturn).not.toHaveBeenCalled();

    tx.$queryRaw.mockClear();
    await expect(insertTelemetryBulk(tx, [], [rule])).resolves.toEqual({
      inserted: 0,
      alerts: 0,
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
  });
});
