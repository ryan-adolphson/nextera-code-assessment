import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { bytesEtag } from '../common/etag.js';

/** A serialized response: shared by every request that hits it, never mutated. */
export interface CachedBody {
  readonly body: Buffer;
  readonly etag: string;
}

interface Entry {
  readonly value: CachedBody;
  readonly expiresAt: number;
}

export const DEFAULT_FARMS_CACHE_TTL_MS = 5000;

/**
 * In-process cache of the `GET /api/farms` response as serialized JSON bytes plus their ETag, so
 * concurrent requests share one buffer and skip `JSON.stringify` (at 10,000 turbines the body is
 * 3.6 MB). The response doesn't vary by user (the route's guards still run first).
 *
 * - Single-flight: concurrent misses share one load. A failed load isn't cached; every request
 *   that joined it fails, the next one loads again.
 * - `invalidate()` drops the entry and bumps a generation: a load that started before it is still
 *   returned to the requests that joined it, but never stored, and later requests don't join it.
 * - TTL `FARMS_CACHE_TTL_MS` (default 5000; 0 = no caching, no sharing).
 * - Per instance: other instances are invalidated by `fleet.changed` on the Redis channel.
 */
@Injectable()
export class FarmsCacheService {
  private readonly ttlMs: number;
  private entry?: Entry;
  private inflight?: Promise<CachedBody>;
  private generation = 0;

  constructor(config: ConfigService) {
    this.ttlMs = config.get<number>(
      'FARMS_CACHE_TTL_MS',
      DEFAULT_FARMS_CACHE_TTL_MS,
    );
  }

  /** The cached response, or `load()` serialized and (if still current) stored. */
  get(load: () => Promise<unknown>): Promise<CachedBody> {
    if (this.ttlMs <= 0) return this.build(load);

    const entry = this.entry;
    if (entry && entry.expiresAt > Date.now())
      return Promise.resolve(entry.value);
    if (this.inflight) return this.inflight;

    const generation = this.generation;
    const flight: Promise<CachedBody> = this.build(load)
      .then((built) => {
        if (generation === this.generation) {
          this.entry = { value: built, expiresAt: Date.now() + this.ttlMs };
        }
        return built;
      })
      .finally(() => {
        if (this.inflight === flight) this.inflight = undefined;
      });
    this.inflight = flight;
    return flight;
  }

  /** Call after a write that changes the farms response has committed. */
  invalidate(): void {
    this.generation++;
    this.entry = undefined;
    this.inflight = undefined;
  }

  private async build(load: () => Promise<unknown>): Promise<CachedBody> {
    const body = Buffer.from(JSON.stringify(await load()));
    return { body, etag: bytesEtag(body) };
  }
}
