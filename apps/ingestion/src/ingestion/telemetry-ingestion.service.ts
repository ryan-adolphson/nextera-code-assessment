import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  EventStore,
  Prisma,
  PrismaService,
  TELEMETRY_RECEIVED,
  toTelemetryResponse,
  triggeredAlerts,
  type AlertConfig,
  type Telemetry,
  type TelemetryWithAlerts,
} from '@nextera/shared';
import { IngestTelemetryDto } from './ingest-telemetry.dto.js';
import {
  ParsedTelemetryCsv,
  RowError,
  TelemetryCsvError,
  TelemetryCsvRow,
} from './telemetry-csv.js';

export type IngestResult = 'stored' | 'duplicate';

export interface BatchResult {
  rows: number;
  inserted: number;
  /** Rows already stored (same turbine + timestamp), including repeats within the file. */
  duplicates: number;
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
   * skipped without a write or an event. Unknown turbines and farm mismatches are rejected (400),
   * which sends the message to the dead-letter topic for inspection or replay.
   */
  async ingest(
    dto: IngestTelemetryDto,
    publishTime?: string,
  ): Promise<IngestResult> {
    const [problem] = await this.checkTurbines([{ line: 0, reading: dto }]);
    if (problem) throw new BadRequestException(problem.errors[0]);

    const reading = await this.prisma.$transaction(async (tx) => {
      const [inserted] = await tx.telemetry.createManyAndReturn({
        data: [
          toRow(dto, new Date(dto.received_at ?? publishTime ?? Date.now())),
        ],
        skipDuplicates: true,
      });
      if (!inserted) return null;
      const [withAlerts] = await storeAlerts(
        tx,
        [inserted],
        await enabledRules(tx),
      );
      return withAlerts;
    });
    if (!reading) return 'duplicate';

    // Published only after the row is committed.
    try {
      await this.events.publish(
        TELEMETRY_RECEIVED,
        toTelemetryResponse(reading),
      );
    } catch (error) {
      // Remove the row (its telemetry_alerts cascade) so Pub/Sub's retry stores and publishes it
      // again; otherwise the retry would be skipped as a duplicate and the event lost.
      await this.prisma.telemetry
        .delete({ where: { id: reading.id } })
        .catch(() => undefined);
      throw error;
    }
    return 'stored';
  }

  /**
   * Stores a parsed CSV upload atomically. Format errors from parsing and turbine/farm errors from
   * the database are reported together, by line; if there are any, nothing is written.
   * Existing readings are skipped (idempotent re-uploads). New readings get the enabled alert rules
   * they trigger (telemetry_alerts) in the same transaction.
   * Publishes one telemetry.received per turbine (its newest new reading) rather than one per row,
   * so a large backfill doesn't flood dashboards.
   */
  async ingestBatch(
    { rows, rowErrors }: ParsedTelemetryCsv,
    uploadedAt = new Date(),
  ): Promise<BatchResult> {
    const problems = [...rowErrors, ...(await this.checkTurbines(rows))].sort(
      (a, b) => a.line - b.line,
    );
    if (problems.length) {
      throw new TelemetryCsvError(
        'The CSV file contains invalid rows',
        problems,
      );
    }

    const data = rows.map(({ reading }) =>
      toRow(
        reading,
        reading.received_at ? new Date(reading.received_at) : uploadedAt,
      ),
    );
    const inserted = await this.prisma.$transaction(
      async (tx) => {
        const rules = await enabledRules(tx);
        const stored: TelemetryWithAlerts[] = [];
        for (let i = 0; i < data.length; i += BATCH_SIZE) {
          const readings = await tx.telemetry.createManyAndReturn({
            data: data.slice(i, i + BATCH_SIZE),
            skipDuplicates: true,
          });
          stored.push(...(await storeAlerts(tx, readings, rules)));
        }
        return stored;
      },
      { timeout: 60_000 },
    );

    await this.publishNewestPerTurbine(inserted);
    return {
      rows: rows.length,
      inserted: inserted.length,
      duplicates: rows.length - inserted.length,
      turbines: [...new Set(rows.map((r) => r.reading.turbine_id))].sort(),
    };
  }

  /** One error per row whose turbine is unknown or not on the given farm. */
  private async checkTurbines(rows: TelemetryCsvRow[]): Promise<RowError[]> {
    const ids = [...new Set(rows.map((r) => r.reading.turbine_id))];
    const turbines = await this.prisma.turbine.findMany({
      where: { turbineId: { in: ids } },
      select: { turbineId: true, farmId: true },
    });
    const farmOf = new Map(turbines.map((t) => [t.turbineId, t.farmId]));

    return rows.flatMap(({ line, reading: r }) => {
      const farmId = farmOf.get(r.turbine_id);
      if (!farmId)
        return [{ line, errors: [`Unknown turbine ${r.turbine_id}`] }];
      if (farmId !== r.farm_id) {
        return [
          {
            line,
            errors: [
              `Turbine ${r.turbine_id} belongs to ${farmId}, not ${r.farm_id}`,
            ],
          },
        ];
      }
      return [];
    });
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
}

/** The rules ingestion evaluates: the enabled ones, read inside the write transaction. */
function enabledRules(tx: Prisma.TransactionClient): Promise<AlertConfig[]> {
  return tx.alertConfig.findMany({ where: { enabled: true } });
}

/**
 * Evaluates new readings against `rules`, stores one telemetry_alerts row per triggered rule, and
 * returns the readings with their alerts (worst first) for the SSE event, without re-reading.
 */
async function storeAlerts(
  tx: Prisma.TransactionClient,
  readings: Telemetry[],
  rules: AlertConfig[],
): Promise<TelemetryWithAlerts[]> {
  const withAlerts = readings.map((reading) => ({
    ...reading,
    alerts: triggeredAlerts(reading, rules).map((alert) => ({ alert })),
  }));
  const links = withAlerts.flatMap((reading) =>
    reading.alerts.map(({ alert }) => ({
      telemetryId: reading.id,
      alertId: alert.id,
    })),
  );
  if (links.length) await tx.telemetryAlert.createMany({ data: links });
  return withAlerts;
}

function toRow(dto: IngestTelemetryDto, receivedAt: Date) {
  return {
    turbineId: dto.turbine_id,
    farmId: dto.farm_id,
    timestamp: new Date(dto.timestamp),
    receivedAt,
    powerOutputKw: dto.power_output_kw,
    windSpeedMs: dto.wind_speed_ms,
    rotorRpm: dto.rotor_rpm,
    bladePitchDeg: dto.blade_pitch_deg,
    gearboxTempC: dto.gearbox_temp_c,
  };
}
