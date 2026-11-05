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
    // RETURNING of the quiet insert: the rows as stored (the test says which were new).
    tx.$queryRaw.mockImplementation((async (
      _sql: unknown,
      ...arrays: unknown[][]
    ) =>
      (arrays[0] as string[]).map((turbineId, i) => ({
        id: `q-${i}`,
        turbine_id: turbineId,
        farm_id: arrays[1][i],
        timestamp: new Date(arrays[2][i] as string),
        received_at: new Date(arrays[3][i] as string),
        power_output_kw: arrays[4][i],
        wind_speed_ms: arrays[5][i],
        rotor_rpm: arrays[6][i],
        blade_pitch_deg: arrays[7][i],
        gearbox_temp_c: arrays[8][i],
      }))) as never);
    tx.$executeRaw.mockResolvedValue(1);
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
      data: [
        {
          telemetryId: 't-0',
          readingTimestamp: hot.timestamp,
          alertId: 'rule-hot',
        },
      ],
    });
  });

  it('upserts turbine_latest for the quiet and the flagged readings, newest only and in turbine order', async () => {
    const hot = row(10, { gearboxTempC: 126.5, turbineId: 'TURB003' });
    await insertTelemetryBulk(
      tx,
      [row(5, { turbineId: 'TURB002' }), hot, row(0, { turbineId: 'TURB002' })],
      [rule],
    );

    // One upsert for the quiet rows (TURB002 twice → one row, its newest), one for the flagged.
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    const calls = tx.$executeRaw.mock.calls as unknown as [
      TemplateStringsArray,
      ...unknown[][],
    ][];
    expect(calls[0][0].join('?')).toMatch(/INSERT INTO turbine_latest/);
    expect(calls[0][1]).toEqual(['TURB002']);
    expect(calls[0][3]).toEqual(['q-0']); // the 12:05 reading, not 12:00
    expect(calls[0][11]).toEqual([null]);
    // The flagged reading carries its worst level.
    expect(calls[1][1]).toEqual(['TURB003']);
    expect(calls[1][11]).toEqual(['error']);
  });

  it('counts only new readings (duplicates are skipped by ON CONFLICT DO NOTHING)', async () => {
    tx.$queryRaw.mockResolvedValue([] as never);
    await expect(
      insertTelemetryBulk(tx, [row(0), row(5)], [rule]),
    ).resolves.toEqual({ inserted: 0, alerts: 0 });
    expect(tx.telemetry.createManyAndReturn).not.toHaveBeenCalled();
    // Nothing new, nothing to upsert.
    expect(tx.$executeRaw).not.toHaveBeenCalled();
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
