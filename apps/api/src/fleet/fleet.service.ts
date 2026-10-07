import { Injectable, NotFoundException } from '@nestjs/common';
import {
  Prisma,
  PrismaService,
  TELEMETRY_ALERTS_INCLUDE,
  TELEMETRY_METRIC_COLUMNS,
  TELEMETRY_METRICS,
  toFarmResponse,
  toTelemetryResponse,
  toTelemetryStatsResponse,
  toTurbineResponse,
  type FarmResponse,
  type Telemetry,
  type TelemetryResponse,
  type TelemetryStatsResponse,
  type TelemetryStatsRow,
  type TelemetryWithAlerts,
  type TurbineResponse,
} from '@nextera/shared';
import { TelemetryQueryDto } from './dto/telemetry-query.dto.js';

export interface TurbineOverview extends TurbineResponse {
  /** Most recent reading by measurement time (not arrival time); null if none yet. */
  latest: TelemetryResponse | null;
}

export interface FarmOverview extends FarmResponse {
  turbines: TurbineOverview[];
}

/** Raw row shape of the telemetry table (snake_case columns). */
interface TelemetryRow {
  id: string;
  turbine_id: string;
  farm_id: string;
  timestamp: Date;
  received_at: Date;
  created_at: Date;
  power_output_kw: number;
  wind_speed_ms: number;
  rotor_rpm: number;
  blade_pitch_deg: number;
  gearbox_temp_c: number;
}

const fromRow = (r: TelemetryRow): Telemetry => ({
  id: r.id,
  turbineId: r.turbine_id,
  farmId: r.farm_id,
  timestamp: r.timestamp,
  receivedAt: r.received_at,
  createdAt: r.created_at,
  powerOutputKw: r.power_output_kw,
  windSpeedMs: r.wind_speed_ms,
  rotorRpm: r.rotor_rpm,
  bladePitchDeg: r.blade_pitch_deg,
  gearboxTempC: r.gearbox_temp_c,
});

/**
 * Per metric: `<column>_median`, `<column>_high`, `<column>_low`. The column names are fixed
 * constants (never user input), so Prisma.raw is safe here. All values are double precision,
 * so they arrive as JS numbers.
 */
const METRIC_AGGREGATES = Prisma.raw(
  TELEMETRY_METRICS.map((metric) => {
    const c = TELEMETRY_METRIC_COLUMNS[metric];
    return [
      `percentile_cont(0.5) WITHIN GROUP (ORDER BY w.${c}) AS ${c}_median`,
      `max(w.${c}) AS ${c}_high`,
      `min(w.${c}) AS ${c}_low`,
    ].join(',\n  ');
  }).join(',\n  '),
);

@Injectable()
export class FleetService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every farm with its turbines and each turbine's latest reading: the fleet overview. */
  async overview(): Promise<FarmOverview[]> {
    const [farms, latestRows] = await Promise.all([
      this.prisma.farm.findMany({
        orderBy: { id: 'asc' },
        include: { turbines: { orderBy: { turbineId: 'asc' } } },
      }),
      // One index lookup per turbine on (turbine_id, timestamp). Prisma's nested `take: 1` would
      // load every reading into memory, which doesn't scale with history size.
      this.prisma.$queryRaw<TelemetryRow[]>`
        SELECT latest.*
        FROM turbines t
        CROSS JOIN LATERAL (
          SELECT * FROM telemetry r
          WHERE r.turbine_id = t.turbine_id
          ORDER BY r.timestamp DESC
          LIMIT 1
        ) latest`,
    ]);

    const latest = await this.withAlerts(latestRows.map(fromRow));
    const latestByTurbine = new Map(
      latest.map((reading) => [
        reading.turbineId,
        toTelemetryResponse(reading),
      ]),
    );
    return farms.map((farm) => ({
      ...toFarmResponse(farm),
      turbines: farm.turbines.map((turbine) => ({
        ...toTurbineResponse(turbine),
        latest: latestByTurbine.get(turbine.turbineId) ?? null,
      })),
    }));
  }

  /** A turbine's readings, newest first, within an optional time range. */
  async telemetry(
    turbineId: string,
    query: TelemetryQueryDto,
  ): Promise<TelemetryResponse[]> {
    await this.assertTurbineExists(turbineId);

    const readings = await this.prisma.telemetry.findMany({
      where: {
        turbineId,
        timestamp: {
          ...(query.from && { gte: new Date(query.from) }),
          ...(query.to && { lt: new Date(query.to) }),
        },
      },
      orderBy: { timestamp: 'desc' },
      take: query.limit,
      include: TELEMETRY_ALERTS_INCLUDE, // the triggered rules, joined from alerts_config
    });
    return readings.map(toTelemetryResponse);
  }

  /**
   * Adds each reading's triggered rules (telemetry_alerts joined with alerts_config) to readings
   * loaded with raw SQL: one query for all of them.
   */
  private async withAlerts(
    readings: Telemetry[],
  ): Promise<TelemetryWithAlerts[]> {
    if (!readings.length) return [];
    const links = await this.prisma.telemetryAlert.findMany({
      where: { telemetryId: { in: readings.map((r) => r.id) } },
      include: { alert: true },
    });
    const byReading = new Map<string, typeof links>();
    for (const link of links) {
      byReading.set(link.telemetryId, [
        ...(byReading.get(link.telemetryId) ?? []),
        link,
      ]);
    }
    return readings.map((reading) => ({
      ...reading,
      alerts: byReading.get(reading.id) ?? [],
    }));
  }

  /**
   * Median, high and low of every metric over exactly the readings `telemetry()` returns for the
   * same query: [from, to) on measurement time, the newest `limit`. One aggregate query in Postgres.
   */
  async telemetryStats(
    turbineId: string,
    query: TelemetryQueryDto,
  ): Promise<TelemetryStatsResponse> {
    await this.assertTurbineExists(turbineId);

    const from = query.from
      ? Prisma.sql`AND r.timestamp >= ${new Date(query.from)}`
      : Prisma.empty;
    const to = query.to
      ? Prisma.sql`AND r.timestamp < ${new Date(query.to)}`
      : Prisma.empty;
    // Aggregates without GROUP BY always return one row (count 0 and nulls for an empty window).
    const [row] = await this.prisma.$queryRaw<TelemetryStatsRow[]>`
      SELECT
        count(*)::int AS count,
        min(w.timestamp) AS first_timestamp,
        max(w.timestamp) AS last_timestamp,
        ${METRIC_AGGREGATES}
      FROM (
        SELECT * FROM telemetry r
        WHERE r.turbine_id = ${turbineId} ${from} ${to}
        ORDER BY r.timestamp DESC
        LIMIT ${query.limit}
      ) w`;
    return toTelemetryStatsResponse(turbineId, row);
  }

  private async assertTurbineExists(turbineId: string): Promise<void> {
    const turbine = await this.prisma.turbine.findUnique({
      where: { turbineId },
      select: { turbineId: true },
    });
    if (!turbine) throw new NotFoundException(`Turbine ${turbineId} not found`);
  }
}
