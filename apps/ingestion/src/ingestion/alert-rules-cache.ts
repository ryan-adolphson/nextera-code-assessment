import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  PrismaService,
  enabledAlertRules,
  type AlertConfig,
} from '@nextera/shared';

/** Default `ALERT_RULES_CACHE_TTL_MS`: how long a rule edit may take to reach ingestion. */
export const DEFAULT_ALERT_RULES_CACHE_TTL_MS = 30_000;

/**
 * The enabled alert rules, cached for ALERT_RULES_CACHE_TTL_MS (default 30 s; 0 turns the cache
 * off) instead of read per batch: at thousands of readings a second the same handful of rows
 * would be queried in every flush. A rule created, edited, enabled, disabled or deleted through
 * the API therefore takes up to the TTL to apply to NEW readings in each worker (readings stored
 * meanwhile keep the alerts they got).
 *
 * Single-flight, and a load that was started before `invalidate()` is never stored. If a reload
 * fails, the last rules (however old) are used and a warning is logged, so a database blip can't
 * stop ingestion more than the transaction itself does. A deleted rule that is still cached
 * makes the alert insert fail on the foreign key; the batcher invalidates on any failed batch, so
 * the retry reads the current rules.
 */
@Injectable()
export class AlertRulesCache {
  private readonly logger = new Logger(AlertRulesCache.name);
  private readonly ttlMs: number;
  private cached: { rules: AlertConfig[]; loadedAt: number } | undefined;
  private loading: Promise<AlertConfig[]> | undefined;
  private generation = 0;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService,
  ) {
    this.ttlMs = config.get<number>(
      'ALERT_RULES_CACHE_TTL_MS',
      DEFAULT_ALERT_RULES_CACHE_TTL_MS,
    );
  }

  async get(now: number = Date.now()): Promise<AlertConfig[]> {
    if (this.ttlMs <= 0) return enabledAlertRules(this.prisma);
    if (this.cached && now - this.cached.loadedAt < this.ttlMs) {
      return this.cached.rules;
    }
    this.loading ??= this.load(now);
    return this.loading;
  }

  /** Forget the cached rules: the next `get` reads the database. */
  invalidate(): void {
    this.generation++;
    this.cached = undefined;
  }

  private async load(now: number): Promise<AlertConfig[]> {
    const generation = this.generation;
    try {
      const rules = await enabledAlertRules(this.prisma);
      if (generation === this.generation) {
        this.cached = { rules, loadedAt: now };
      }
      return rules;
    } catch (error) {
      if (this.cached) {
        this.logger.warn(
          `Reading the alert rules failed (${(error as Error).message}); using the last ones`,
        );
        return this.cached.rules;
      }
      throw error;
    } finally {
      this.loading = undefined;
    }
  }
}
