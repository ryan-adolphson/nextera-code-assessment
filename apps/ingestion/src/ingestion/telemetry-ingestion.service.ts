import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  EventStore,
  PrismaService,
  TELEMETRY_RECEIVED,
  UNALLOCATED_CHANGED,
  UnallocatedCapError,
  classifyReadings,
  enabledAlertRules,
  holdReadings,
  insertTelemetryWithAlerts,
  storeAlerts,
  toTelemetryResponse,
  type HeldEntry,
  type HoldableReading,
  type TelemetryRowInput,
  type TelemetryWithAlerts,
  type UnallocatedChangedEvent,
} from '@nextera/shared';
import { IngestTelemetryDto } from './ingest-telemetry.dto.js';
import { ParsedTelemetryCsv, TelemetryCsvError } from './telemetry-csv.js';

/**
 * What happened to a Pub/Sub reading (all acked with 204): stored in telemetry, a duplicate of a
 * stored reading, held as an unallocated turbine (unknown turbine or farm mismatch), or dropped
 * because its (turbine, farm) pair is blocked.
 */
export type IngestResult = 'stored' | 'duplicate' | 'held' | 'blocked';

/** CSV upload result. rows = inserted + duplicates + held + blocked. */
export interface BatchResult {
  rows: number;
  inserted: number;
  /** Rows already stored (same turbine + timestamp), including repeats within the file. */
  duplicates: number;
  /** Rows of unknown turbines or farm mismatches, held for an owner to assign, keep or move. */
  held: number;
  /** Rows of blocked (turbine, farm) pairs, dropped. */
  blocked: number;
  /** Every turbine id in the file. */
  turbines: string[];
}

const BATCH_SIZE = 1000;

@Injectable()
export class TelemetryIngestionService {
  private readonly logger = new Logger(TelemetryIngestionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventStore,
  ) {}

  /**
   * Stores one reading (a Pub/Sub message) with the enabled alert rules it triggers
   * (telemetry_alerts, same transaction) and publishes telemetry.received for SSE.
   * Idempotent: (turbine_id, timestamp) is unique, so Pub/Sub redeliveries and re-sent readings are
   * skipped without a write or an event. A reading of an unknown turbine or with the wrong farm is
   * held (held_telemetry) for an owner to resolve, and one of a blocked pair is dropped; both are
   * acked. Only invalid payloads and new pairs over MAX_PENDING_UNALLOCATED are rejected (400 →
   * dead-letter topic).
   */
  async ingest(
    dto: IngestTelemetryDto,
    publishTime?: string,
  ): Promise<IngestResult> {
    const row = toRow(
      dto,
      new Date(dto.received_at ?? publishTime ?? Date.now()),
    );

    const outcome = await this.prisma
      .$transaction(async (tx) => {
        const [kind] = await classifyReadings(tx, [row]);
        if (kind === 'blocked') return { result: 'blocked' as const };
        if (kind !== 'known') {
          const entries = await holdReadings(tx, [{ ...row, kind }]);
          return { result: 'held' as const, entries };
        }

        const [inserted] = await tx.telemetry.createManyAndReturn({
          data: [row],
          skipDuplicates: true,
        });
        // A duplicate: no rules to read, no alerts to write.
        if (!inserted) return { result: 'duplicate' as const };
        const [reading] = await storeAlerts(
          tx,
          [inserted],
          await enabledAlertRules(tx),
        );
        return { result: 'stored' as const, reading };
      })
      .catch(rejectOverCap);

    if (outcome.result === 'held') await this.publishHeld(outcome.entries);
    if (outcome.result === 'blocked') {
      this.logger.debug(
        `Reading ${row.turbineId} on ${row.farmId} dropped: the pair is blocked`,
      );
    }
    if (outcome.result !== 'stored') return outcome.result;

    // Published only after the row is committed. The row is the source of truth and the live event
    // is best-effort: a Redis failure is logged and the push still acked, so a Redis outage never
    // sends committed readings to the dead-letter topic; dashboards catch up on their next load.
    const { reading } = outcome;
    try {
      await this.events.publish(
        TELEMETRY_RECEIVED,
        toTelemetryResponse(reading),
      );
    } catch (error) {
      this.logger.warn(
        `Reading ${reading.turbineId} at ${reading.timestamp.toISOString()} stored, but live update failed: ${(error as Error).message}`,
      );
    }
    return 'stored';
  }

  /**
   * Stores a parsed CSV upload atomically. Any format error rejects the whole file (errors by
   * line, nothing written). Otherwise, in one transaction: rows of known turbines go to telemetry
   * (existing readings skipped: idempotent re-uploads) with the enabled alert rules they trigger,
   * rows of unknown turbines or farm mismatches are held, and rows of blocked pairs are dropped.
   * New pairs over MAX_PENDING_UNALLOCATED reject the file too (their lines are reported).
   * Publishes one telemetry.received per turbine (its newest new reading) rather than one per row,
   * so a large backfill doesn't flood dashboards.
   */
  async ingestBatch(
    { rows, rowErrors }: ParsedTelemetryCsv,
    uploadedAt = new Date(),
  ): Promise<BatchResult> {
    if (rowErrors.length) {
      throw new TelemetryCsvError(
        'The CSV file contains invalid rows',
        [...rowErrors].sort((a, b) => a.line - b.line),
      );
    }

    const data = rows.map(({ reading }) =>
      toRow(
        reading,
        reading.received_at ? new Date(reading.received_at) : uploadedAt,
      ),
    );
    const { inserted, entries, held, blocked } = await this.prisma
      .$transaction(
        async (tx) => {
          const kinds = await classifyReadings(tx, data);
          const known: TelemetryRowInput[] = [];
          const holdable: HoldableReading[] = [];
          let blocked = 0;
          data.forEach((row, i) => {
            const kind = kinds[i];
            if (kind === 'known') known.push(row);
            else if (kind === 'blocked') blocked++;
            else holdable.push({ ...row, kind });
          });

          const entries = holdable.length
            ? await holdReadings(tx, holdable)
            : [];
          const rules = await enabledAlertRules(tx);
          const inserted: TelemetryWithAlerts[] = [];
          for (let i = 0; i < known.length; i += BATCH_SIZE) {
            inserted.push(
              ...(await insertTelemetryWithAlerts(
                tx,
                known.slice(i, i + BATCH_SIZE),
                rules,
              )),
            );
          }
          return { inserted, entries, held: holdable.length, blocked };
        },
        { timeout: 60_000 },
      )
      .catch((error: unknown) => {
        if (!(error instanceof UnallocatedCapError)) throw error;
        const rejected = new Set(
          error.pairs.map((p) => `${p.turbineId}\u0000${p.farmId}`),
        );
        throw new TelemetryCsvError(
          'The CSV file contains invalid rows',
          rows
            .filter(({ reading: r }) =>
              rejected.has(`${r.turbine_id}\u0000${r.farm_id}`),
            )
            .map(({ line, reading: r }) => ({
              line,
              errors: [UnallocatedCapError.messageFor(r.turbine_id, r.farm_id)],
            })),
        );
      });

    await this.publishNewestPerTurbine(inserted);
    await this.publishHeld(entries);
    return {
      rows: rows.length,
      inserted: inserted.length,
      duplicates: rows.length - inserted.length - held - blocked,
      held,
      blocked,
      turbines: [...new Set(rows.map((r) => r.reading.turbine_id))].sort(),
    };
  }

  /**
   * The data is already committed, so a Redis failure here doesn't fail the upload (a retry would
   * only find duplicates); dashboards catch up on their next load.
   */
  private async publishNewestPerTurbine(
    inserted: TelemetryWithAlerts[],
  ): Promise<void> {
    const newest = new Map<string, TelemetryWithAlerts>();
    for (const reading of inserted) {
      const current = newest.get(reading.turbineId);
      if (!current || reading.timestamp > current.timestamp) {
        newest.set(reading.turbineId, reading);
      }
    }
    try {
      for (const reading of newest.values()) {
        await this.events.publish(
          TELEMETRY_RECEIVED,
          toTelemetryResponse(reading),
        );
      }
    } catch (error) {
      this.logger.warn(
        `CSV upload stored, but live update failed: ${(error as Error).message}`,
      );
    }
  }

  /**
   * unallocated-turbine.changed ('held') for the entries that were created or, at most once a
   * minute, got new readings (HeldEntry.notify). After the commit, best-effort like the others.
   */
  private async publishHeld(entries: HeldEntry[]): Promise<void> {
    for (const entry of entries) {
      this.logger.log(
        `Held ${entry.held} reading(s) of ${entry.turbineId} reporting ${entry.reportedFarmId} (${entry.kind}${entry.created ? ', new' : ''})`,
      );
    }
    try {
      for (const entry of entries.filter((e) => e.notify)) {
        const event: UnallocatedChangedEvent = {
          action: 'held',
          id: entry.id,
          turbineId: entry.turbineId,
        };
        await this.events.publish(UNALLOCATED_CHANGED, event);
      }
    } catch (error) {
      this.logger.warn(
        `Readings held, but live update failed: ${(error as Error).message}`,
      );
    }
  }
}

/** A new unallocated pair over the cap: 400, so Pub/Sub retries and dead-letters the message. */
function rejectOverCap(error: unknown): never {
  if (error instanceof UnallocatedCapError) {
    throw new BadRequestException(error.message);
  }
  throw error;
}

function toRow(dto: IngestTelemetryDto, receivedAt: Date): TelemetryRowInput {
  return {
    turbineId: dto.turbine_id,
    farmId: dto.farm_id,
    timestamp: validDate(new Date(dto.timestamp), 'timestamp'),
    receivedAt: validDate(receivedAt, 'received_at'),
    powerOutputKw: dto.power_output_kw,
    windSpeedMs: dto.wind_speed_ms,
    rotorRpm: dto.rotor_rpm,
    bladePitchDeg: dto.blade_pitch_deg,
    gearboxTempC: dto.gearbox_temp_c,
  };
}

/**
 * Validation (IsUtcTimestamp) makes an Invalid Date unreachable here; this keeps one from ever
 * reaching Prisma (a 500 and a retry loop) if a caller skips it.
 */
function validDate(date: Date, field: string): Date {
  if (Number.isNaN(date.getTime())) {
    throw new BadRequestException(`${field} is not a valid date`);
  }
  return date;
}
