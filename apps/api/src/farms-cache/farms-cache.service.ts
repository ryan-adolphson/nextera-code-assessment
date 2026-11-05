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

const FARMS_KEY = 'farms';

export const DEFAULT_FARMS_CACHE_TTL_MS = 5000;

/**
 * In-process cache of fleet responses as serialized JSON bytes plus their ETag, so concurrent
 * requests share one buffer and skip `JSON.stringify`: `GET /api/farms` (key `farms`, the default
 * of `get(load)`), `GET /api/farm-summaries` and `GET /api/fleet/summary` (own keys, `getKeyed`).
 * The responses don't vary by user (the route's guards still run first).
 *
 * - Single-flight: concurrent misses share one load. A failed load isn't cached; every request
 *   that joined it fails, the next one loads again.
 * - `invalidate()` drops every entry and bumps a generation: a load that started before it is
 *   still returned to the requests that joined it, but never stored, and later requests don't
 *   join it.
 * - TTL `FARMS_CACHE_TTL_MS` (default 5000; 0 = no caching, no sharing).
 * - Per instance: other instances are invalidated by `fleet.changed` on the Redis channel.
 */
@Injectable()
export class FarmsCacheService {
  private readonly ttlMs: number;
  private readonly entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<CachedBody>>();
  private generation = 0;

  constructor(config: ConfigService) {
    this.ttlMs = config.get<number>(
      'FARMS_CACHE_TTL_MS',
      DEFAULT_FARMS_CACHE_TTL_MS,
    );
  }

  /** The cached farms overview, or `load()` serialized and (if still current) stored. */
  get(load: () => Promise<unknown>): Promise<CachedBody> {
    return this.getKeyed(FARMS_KEY, load);
  }

  /** The same for another response, under its own `key`. */
  getKeyed(key: string, load: () => Promise<unknown>): Promise<CachedBody> {
    if (this.ttlMs <= 0) return this.build(load);

    const entry = this.entries.get(key);
    if (entry && entry.expiresAt > Date.now())
      return Promise.resolve(entry.value);
    const joined = this.inflight.get(key);
    if (joined) return joined;

    const generation = this.generation;
    const flight: Promise<CachedBody> = this.build(load)
      .then((built) => {
        if (generation === this.generation) {
          this.entries.set(key, {
            value: built,
            expiresAt: Date.now() + this.ttlMs,
          });
        }
        return built;
      })
      .finally(() => {
        if (this.inflight.get(key) === flight) this.inflight.delete(key);
      });
    this.inflight.set(key, flight);
    return flight;
  }

  /** Call after a write that changes a cached response has committed. */
  invalidate(): void {
    this.generation++;
    this.entries.clear();
    this.inflight.clear();
  }

  private async build(load: () => Promise<unknown>): Promise<CachedBody> {
    const body = Buffer.from(JSON.stringify(await load()));
    return { body, etag: bytesEtag(body) };
  }
}
