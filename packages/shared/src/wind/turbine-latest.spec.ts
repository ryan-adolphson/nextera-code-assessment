import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import type { Prisma } from '../generated/prisma/client.js';
import {
  upsertTurbineLatest,
  worstAlertLevel,
  type LatestCandidate,
} from './turbine-latest.js';

const reading = (
  turbineId: string,
  minute: number,
  overrides: Partial<LatestCandidate> = {},
): LatestCandidate => ({
  id: `${turbineId}-${minute}`,
  turbineId,
  farmId: 'FARM01',
  timestamp: new Date(Date.UTC(2026, 2, 1, 0, minute)),
  receivedAt: new Date(Date.UTC(2026, 2, 1, 1, 0)),
  powerOutputKw: 1000 + minute,
  windSpeedMs: 8,
  rotorRpm: 14,
  bladePitchDeg: 3,
  gearboxTempC: 70,
  worstAlertLevel: null,
  ...overrides,
});

describe('worstAlertLevel', () => {
  const alert = (alertLevel: 'info' | 'warn' | 'error') => ({
    alert: { alertLevel },
  });

  it('is the most severe level, null for none', () => {
    expect(worstAlertLevel([])).toBeNull();
    expect(worstAlertLevel([alert('info')])).toBe('info');
    expect(worstAlertLevel([alert('warn'), alert('info')])).toBe('warn');
    expect(
      worstAlertLevel([alert('info'), alert('error'), alert('warn')]),
    ).toBe('error');
  });
});

describe('upsertTurbineLatest', () => {
  let tx: DeepMockProxy<Prisma.TransactionClient>;
  const calls = () =>
    tx.$executeRaw.mock.calls as unknown as [
      TemplateStringsArray,
      ...unknown[][],
    ][];

  beforeEach(() => {
    tx = mockDeep<Prisma.TransactionClient>();
    tx.$executeRaw.mockResolvedValue(1);
  });

  it('writes only the newest reading per turbine, in turbine id order', async () => {
    await upsertTurbineLatest(tx, [
      reading('TURB010', 5),
      reading('TURB002', 0),
      reading('TURB010', 15, { worstAlertLevel: 'warn' }),
      reading('TURB010', 10),
      reading('TURB001', 5),
    ]);

    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    const [sql, turbines, , ids, timestamps, , , , , , , levels] = calls()[0];
    expect(turbines).toEqual(['TURB001', 'TURB002', 'TURB010']); // sorted: the lock order
    expect(ids).toEqual(['TURB001-5', 'TURB002-0', 'TURB010-15']);
    expect(timestamps[2]).toBe('2026-03-01T00:15:00.000Z');
    expect(levels).toEqual([null, null, 'warn']);
    const text = sql.join('?');
    // A late reading never overwrites a newer row, and rows are inserted in "C" order.
    expect(text).toMatch(
      /WHERE turbine_latest\."timestamp" < EXCLUDED\."timestamp"/,
    );
    expect(text).toMatch(/ORDER BY u\.turbine_id COLLATE "C"/);
  });

  it('does nothing without readings', async () => {
    await upsertTurbineLatest(tx, []);
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  it('writes in chunks of 5,000 turbines', async () => {
    const many = Array.from({ length: 5001 }, (_, i) =>
      reading(`T${String(i).padStart(5, '0')}`, 0),
    );
    await upsertTurbineLatest(tx, many);
    expect(tx.$executeRaw).toHaveBeenCalledTimes(2);
    expect(calls()[0][1]).toHaveLength(5000);
    expect(calls()[1][1]).toHaveLength(1);
  });
});
