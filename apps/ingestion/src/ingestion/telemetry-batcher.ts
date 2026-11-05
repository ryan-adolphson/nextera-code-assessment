import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  EventStore,
  PrismaService,
  TELEMETRY_RECEIVED,
  UnallocatedCapError,
  classifyReadings,
  holdReadings,
  insertTelemetryWithAlerts,
  toTelemetryResponse,
  turbineChannel,
  type HeldEntry,
  type HoldableReading,
  type TelemetryRowInput,
  type TelemetryWithAlerts,
} from '@nextera/shared';
import { AlertRulesCache } from './alert-rules-cache.js';
import { publishHeld } from './held-events.js';
import { QueueFullException } from './queue-full.exception.js';

/**
 * What happened to a Pub/Sub reading (all acked with 204): stored in telemetry, a duplicate of a
 * stored reading, held as an unallocated turbine (unknown turbine or farm mismatch), or dropped
 * because its (turbine, farm) pair is blocked.
 */
export type IngestResult = 'stored' | 'duplicate' | 'held' | 'blocked';

const BATCH_TIMEOUT_MS = 30_000;
const RETRY_AFTER_SECONDS = 2;
const WARN_INTERVAL_MS = 60_000;
const DRAIN_DEADLINE_MS = 8_000;

interface Pending {
  row: TelemetryRowInput;
  resolve: (result: IngestResult) => void;
  reject: (error: unknown) => void;
}

const readingKey = (row: { turbineId: string; timestamp: Date }) =>
  `${row.turbineId}\u0000${row.timestamp.getTime()}`;

/** A new unallocated pair over the cap: 400, so Pub/Sub retries and dead-letters the message. */
function rejectOverCap(error: unknown): never {
  if (error instanceof UnallocatedCapError) {
    throw new BadRequestException(error.message);
  }
  throw error;
}

/**
 * Group commit for Pub/Sub pushes (one message per request): the first reading of an idle worker
 * is flushed at once; while a flush runs, others queue and the next flush takes up to
 * INGEST_BATCH_MAX of them in ONE transaction. No timer, one flush at a time per worker, so a
 * lone reading never waits and a burst amortises the transaction cost. A full queue
 * (INGEST_MAX_QUEUED) is refused at once with 503 + Retry-After, writing nothing.
 *
 * If a batch transaction fails, its readings are retried one by one in their own transaction (the
 * pre-batching path), so a bad reading (e.g. a new pair over the unallocated cap → 400) fails alone.
 */
@Injectable()
export class TelemetryBatcher implements OnModuleDestroy {
  private readonly logger = new Logger(TelemetryBatcher.name);
  private readonly batchMax: number;
  private readonly maxQueued: number;
  private readonly queue: Pending[] = [];
  private running: Promise<void> | undefined;
  private closing = false;
  private drainDeadline = 0;
  private lastFullWarning = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventStore,
    config: ConfigService,
    private readonly rules: AlertRulesCache,
  ) {
    this.batchMax = config.get<number>('INGEST_BATCH_MAX', 100);
    this.maxQueued = config.get<number>('INGEST_MAX_QUEUED', 500);
  }

  async submit(row: TelemetryRowInput): Promise<IngestResult> {
    if (this.closing) throw new QueueFullException(RETRY_AFTER_SECONDS);
    if (this.running && this.queue.length >= this.maxQueued) {
      this.warnFull();
      throw new QueueFullException(RETRY_AFTER_SECONDS);
    }
    const result = new Promise<IngestResult>((resolve, reject) => {
      const pending: Pending = { row, resolve, reject };
      if (this.running) this.queue.push(pending);
      else this.running = this.drain(pending);
    });
    return result;
  }

  /** SIGTERM: refuse new readings, finish the queue (within a deadline), reject what is left. */
  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    this.drainDeadline = Date.now() + DRAIN_DEADLINE_MS;
    await this.running;
  }

  private warnFull(): void {
    const now = Date.now();
    if (now - this.lastFullWarning < WARN_INTERVAL_MS) return;
    this.lastFullWarning = now;
    this.logger.warn(
      `Ingest queue full (${this.maxQueued}): rejecting readings with 503`,
    );
  }

  private async drain(first: Pending): Promise<void> {
    let batch = [first];
    try {
      while (batch.length) {
        if (this.closing && Date.now() > this.drainDeadline) {
          for (const p of batch)
            p.reject(new QueueFullException(RETRY_AFTER_SECONDS));
          batch = [];
          for (const p of this.queue.splice(0)) {
            p.reject(new QueueFullException(RETRY_AFTER_SECONDS));
          }
          break;
        }
        await this.flush(batch);
        batch = this.queue.splice(0, this.batchMax);
      }
    } finally {
      // Synchronous with the loop's last check: a submit can't slip in between and be stranded.
      this.running = undefined;
    }
  }

  private async flush(batch: Pending[]): Promise<void> {
    let committed: BatchOutcome;
    try {
      committed = await this.commitBatch(batch.map((p) => p.row));
    } catch (error) {
      this.logger.warn(
        `Batch of ${batch.length} failed (${(error as Error).message}); retrying one by one`,
      );
      // Maybe a rule deleted since it was cached (foreign key): the retries read the current ones.
      this.rules.invalidate();
      for (const p of batch) {
        try {
          p.resolve(await this.ingestOne(p.row));
        } catch (e) {
          p.reject(e);
        }
      }
      return;
    }

    // After the commit; best-effort: Redis never fails a committed reading (a retry would only
    // find duplicates), dashboards catch up on their next load. Readings are live events only:
    // PUBLISHed to their turbine's channel, never added to the stream.
    try {
      if (committed.stored.length) {
        await this.events.publishLive(committed.stored.map(liveReading));
      }
    } catch (error) {
      this.logger.warn(
        `${committed.stored.length} reading(s) stored, but live update failed: ${(error as Error).message}`,
      );
    }
    await publishHeld(this.events, this.logger, committed.entries);
    batch.forEach((p, i) => p.resolve(committed.results[i]));
  }

  /** One transaction for the whole batch (the flow of `ingestBatch`), results in input order. */
  private async commitBatch(rows: TelemetryRowInput[]): Promise<BatchOutcome> {
    // Outside the transaction: a cached read holds no connection.
    const rules = await this.rules.get();
    return this.prisma.$transaction(
      async (tx) => {
        const kinds = await classifyReadings(tx, rows);
        const results: IngestResult[] = Array.from<IngestResult>({
          length: rows.length,
        });
        const known: TelemetryRowInput[] = [];
        const knownAt: number[] = [];
        const holdable: HoldableReading[] = [];
        const seen = new Set<string>();
        rows.forEach((row, i) => {
          const kind = kinds[i];
          if (kind === 'blocked') {
            results[i] = 'blocked';
          } else if (kind !== 'known') {
            results[i] = 'held';
            holdable.push({ ...row, kind });
          } else if (seen.has(readingKey(row))) {
            results[i] = 'duplicate'; // a repeat in the batch: the first occurrence wins
          } else {
            seen.add(readingKey(row));
            known.push(row);
            knownAt.push(i);
          }
        });

        const entries = holdable.length ? await holdReadings(tx, holdable) : [];
        let stored: TelemetryWithAlerts[] = [];
        if (known.length) {
          stored = await insertTelemetryWithAlerts(tx, known, rules);
        }
        const storedKeys = new Set(stored.map(readingKey));
        known.forEach((row, j) => {
          results[knownAt[j]] = storedKeys.has(readingKey(row))
            ? 'stored'
            : 'duplicate'; // already in telemetry
        });
        return { results, stored, entries };
      },
      { timeout: BATCH_TIMEOUT_MS },
    );
  }

  /** The single-reading path (own transaction, own events); the fallback of a failed batch. */
  private async ingestOne(row: TelemetryRowInput): Promise<IngestResult> {
    const rules = await this.rules.get();
    const outcome = await this.prisma
      .$transaction(async (tx) => {
        const [kind] = await classifyReadings(tx, [row]);
        if (kind === 'blocked') return { result: 'blocked' as const };
        if (kind !== 'known') {
          const entries = await holdReadings(tx, [{ ...row, kind }]);
          return { result: 'held' as const, entries };
        }

        // The same insert as the batch path (alerts and turbine_latest included); a duplicate
        // comes back empty.
        const [reading] = await insertTelemetryWithAlerts(tx, [row], rules);
        if (!reading) return { result: 'duplicate' as const };
        return { result: 'stored' as const, reading };
      })
      .catch(rejectOverCap);

    if (outcome.result === 'held') {
      await publishHeld(this.events, this.logger, outcome.entries);
    }
    if (outcome.result === 'blocked') {
      this.logger.debug(
        `Reading ${row.turbineId} on ${row.farmId} dropped: the pair is blocked`,
      );
    }
    if (outcome.result !== 'stored') return outcome.result;

    const { reading } = outcome;
    try {
      await this.events.publishLive([liveReading(reading)]);
    } catch (error) {
      this.logger.warn(
        `Reading ${reading.turbineId} at ${reading.timestamp.toISOString()} stored, but live update failed: ${(error as Error).message}`,
      );
    }
    return 'stored';
  }
}

/** A stored reading as a live event on its turbine's channel. */
const liveReading = (reading: TelemetryWithAlerts) => ({
  channel: turbineChannel(reading.turbineId),
  type: TELEMETRY_RECEIVED,
  data: toTelemetryResponse(reading),
});

interface BatchOutcome {
  results: IngestResult[];
  stored: TelemetryWithAlerts[];
  entries: HeldEntry[];
}
