import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService, type AlertConfig } from '@nextera/shared';
import { mockDeep, type DeepMockProxy } from 'vitest-mock-extended';
import { AlertRulesCache } from './alert-rules-cache.js';

const rule = (id: string): AlertConfig => ({
  id,
  measurementMetric: 'gearboxTempC',
  comparison: 'above',
  valueMetric: 100,
  alertLevel: 'error',
  enabled: true,
});

describe('AlertRulesCache', () => {
  let prisma: DeepMockProxy<PrismaService>;
  const make = (ttl?: number) =>
    new AlertRulesCache(prisma, {
      get: (_key: string, fallback: number) => ttl ?? fallback,
    } as unknown as ConfigService);

  beforeEach(() => {
    prisma = mockDeep<PrismaService>();
    prisma.alertConfig.findMany.mockResolvedValue([rule('a')]);
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });

  it('reads the enabled rules once per TTL (30 s by default), not per call', async () => {
    const cache = make();
    await cache.get(1_000);
    await cache.get(20_000);
    expect(prisma.alertConfig.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { enabled: true },
    });

    prisma.alertConfig.findMany.mockResolvedValue([rule('b')]);
    expect((await cache.get(20_000)).map((r) => r.id)).toEqual(['a']);
    // A rule edit shows up once the TTL has passed.
    expect((await cache.get(31_001)).map((r) => r.id)).toEqual(['b']);
    expect(prisma.alertConfig.findMany).toHaveBeenCalledTimes(2);
  });

  it('shares one read between concurrent callers', async () => {
    const cache = make();
    await Promise.all([cache.get(0), cache.get(0), cache.get(0)]);
    expect(prisma.alertConfig.findMany).toHaveBeenCalledOnce();
  });

  it('a TTL of 0 reads every time', async () => {
    const cache = make(0);
    await cache.get(0);
    await cache.get(0);
    expect(prisma.alertConfig.findMany).toHaveBeenCalledTimes(2);
  });

  it('invalidate() forgets the rules, and a read started before it is never stored', async () => {
    const cache = make();
    await cache.get(0);
    cache.invalidate();
    prisma.alertConfig.findMany.mockResolvedValue([rule('b')]);
    expect((await cache.get(1)).map((r) => r.id)).toEqual(['b']);

    let finish!: (rules: AlertConfig[]) => void;
    prisma.alertConfig.findMany.mockReturnValueOnce(
      new Promise<AlertConfig[]>((resolve) => (finish = resolve)) as never,
    );
    cache.invalidate();
    const slow = cache.get(2);
    cache.invalidate(); // while the read is in flight
    finish([rule('stale')]);
    await slow;
    prisma.alertConfig.findMany.mockResolvedValue([rule('fresh')]);
    expect((await cache.get(3)).map((r) => r.id)).toEqual(['fresh']);
  });

  it('keeps using the last rules when a reload fails, and fails when it has none', async () => {
    const cache = make();
    await expect(cache.get(0)).resolves.toHaveLength(1);
    prisma.alertConfig.findMany.mockRejectedValue(new Error('db down'));
    expect((await cache.get(60_000)).map((r) => r.id)).toEqual(['a']);

    const cold = make();
    await expect(cold.get(0)).rejects.toThrow('db down');
  });
});
