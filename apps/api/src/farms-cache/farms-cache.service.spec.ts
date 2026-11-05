import { ConfigService } from '@nestjs/config';
import { FarmsCacheService } from './farms-cache.service.js';

const cacheWith = (ttl?: number) =>
  new FarmsCacheService({
    get: (_key: string, fallback: number) => ttl ?? fallback,
  } as unknown as ConfigService);

/** A load that resolves when `release()` is called, to hold requests in flight. */
function gate<T>(value: T) {
  let release!: () => void;
  const promise = new Promise<T>((resolve) => (release = () => resolve(value)));
  return { promise, release };
}

describe('FarmsCacheService', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('serves JSON bytes with an ETag and loads once for repeated requests', async () => {
    const cache = cacheWith();
    const load = vi.fn().mockResolvedValue([{ id: 'FARM01' }]);

    const first = await cache.get(load);
    const second = await cache.get(load);

    expect(load).toHaveBeenCalledOnce();
    expect(first.body.toString()).toBe('[{"id":"FARM01"}]');
    expect(first.etag).toMatch(/^W\/"[A-Za-z0-9_-]{43}"$/);
    expect(second).toBe(first); // the very same buffer, not a copy
  });

  it('loads again once the TTL has passed, and the ETag follows the content', async () => {
    const cache = cacheWith(5000);
    const load = vi
      .fn()
      .mockResolvedValueOnce([{ v: 1 }])
      .mockResolvedValueOnce([{ v: 2 }]);

    const first = await cache.get(load);
    vi.advanceTimersByTime(4999);
    expect(await cache.get(load)).toBe(first);
    vi.advanceTimersByTime(1);
    const second = await cache.get(load);

    expect(load).toHaveBeenCalledTimes(2);
    expect(second.etag).not.toBe(first.etag);
  });

  it('single-flights concurrent misses into one load', async () => {
    const cache = cacheWith();
    const { promise, release } = gate([{ id: 'FARM01' }]);
    const load = vi.fn().mockReturnValue(promise);

    const all = Promise.all([
      cache.get(load),
      cache.get(load),
      cache.get(load),
    ]);
    release();
    const [a, b, c] = await all;

    expect(load).toHaveBeenCalledOnce();
    expect(b).toBe(a);
    expect(c).toBe(a);
  });

  it('drops the entry on invalidate()', async () => {
    const cache = cacheWith();
    const load = vi
      .fn()
      .mockResolvedValueOnce([{ v: 1 }])
      .mockResolvedValueOnce([{ v: 2 }]);

    await cache.get(load);
    cache.invalidate();
    const after = await cache.get(load);

    expect(load).toHaveBeenCalledTimes(2);
    expect(after.body.toString()).toBe('[{"v":2}]');
  });

  it('does not store a load that started before an invalidation, and later requests do not join it', async () => {
    const cache = cacheWith();
    const stale = gate([{ v: 'old' }]);
    const load = vi
      .fn()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue([{ v: 'new' }]);

    const before = cache.get(load); // started before the write
    cache.invalidate();
    const after = await cache.get(load); // must not wait for or share the old load
    stale.release();
    expect((await before).body.toString()).toBe('[{"v":"old"}]');

    expect(after.body.toString()).toBe('[{"v":"new"}]');
    expect(load).toHaveBeenCalledTimes(2);
    // The old load finishing later did not overwrite the newer entry.
    expect(await cache.get(load)).toBe(after);
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not store a load that was invalidated while in flight', async () => {
    const cache = cacheWith();
    const stale = gate([{ v: 'old' }]);
    const load = vi
      .fn()
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValue([{ v: 'new' }]);

    const pending = cache.get(load);
    cache.invalidate();
    stale.release();
    await pending;

    expect((await cache.get(load)).body.toString()).toBe('[{"v":"new"}]');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failed load: every waiter fails, the next request retries', async () => {
    const cache = cacheWith();
    const failure = new Error('db down');
    const load = vi
      .fn()
      .mockRejectedValueOnce(failure)
      .mockResolvedValue([{ id: 'FARM01' }]);

    const waiters = [cache.get(load), cache.get(load)];
    await expect(waiters[0]).rejects.toBe(failure);
    await expect(waiters[1]).rejects.toBe(failure);
    expect(load).toHaveBeenCalledOnce();

    const retry = await cache.get(load);
    expect(retry.body.toString()).toBe('[{"id":"FARM01"}]');
    expect(load).toHaveBeenCalledTimes(2);
  });

  it('with a TTL of 0 never caches and never shares a load', async () => {
    const cache = cacheWith(0);
    const load = vi.fn().mockResolvedValue([{ id: 'FARM01' }]);

    await Promise.all([cache.get(load), cache.get(load)]);
    await cache.get(load);

    expect(load).toHaveBeenCalledTimes(3);
  });

  describe('keyed entries', () => {
    it('caches each key separately, and invalidate() drops them all', async () => {
      const cache = cacheWith(5000);
      const farms = vi.fn().mockResolvedValue([1]);
      const summaries = vi.fn().mockResolvedValue([2]);

      await cache.get(farms);
      await cache.getKeyed('farm-summaries', summaries);
      await cache.get(farms);
      await cache.getKeyed('farm-summaries', summaries);
      expect([farms.mock.calls.length, summaries.mock.calls.length]).toEqual([
        1, 1,
      ]);

      cache.invalidate();
      await cache.get(farms);
      await cache.getKeyed('farm-summaries', summaries);
      expect([farms.mock.calls.length, summaries.mock.calls.length]).toEqual([
        2, 2,
      ]);
    });

    it('never stores a keyed load that started before an invalidation', async () => {
      const cache = cacheWith(5000);
      const slow = gate([1]);
      const load = vi
        .fn()
        .mockImplementationOnce(() => slow.promise)
        .mockResolvedValueOnce([2]);

      const first = cache.getKeyed('fleet-summary', load);
      cache.invalidate();
      slow.release();
      await first;
      const second = await cache.getKeyed('fleet-summary', load);

      expect(load).toHaveBeenCalledTimes(2);
      expect(second.body.toString()).toBe('[2]');
    });
  });
});
