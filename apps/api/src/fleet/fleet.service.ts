import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  EventStore,
  FLEET_CHANGED,
  PrismaService,
  farmDailyHistory,
  farmWeather,
  fleetSummary,
  listFarmSummaries,
  listFarms,
  listTurbines,
  turbineItem,
  turbineMarkers,
  telemetryStats,
  toTurbineResponse,
  turbineTelemetry,
  turbineWeather,
  type FarmDailyHistoryResponse,
  type FarmOverview,
  type FarmWeatherResponse,
  type FleetChangedEvent,
  type TurbineListResponse,
  type TurbineListItem,
  type TurbineMarker,
  type TelemetryResponse,
  type TelemetryStatsResponse,
  type TurbineResponse,
  type TurbineWeatherResponse,
} from '@nextera/shared';
import {
  FarmsCacheService,
  type CachedBody,
} from '../farms-cache/farms-cache.service.js';
import { httpQuery } from '../common/query-errors.js';
import { FarmDailyQueryDto } from './dto/farm-daily-query.dto.js';
import { WeatherQueryDto } from './dto/weather-query.dto.js';
import { TelemetryQueryDto } from './dto/telemetry-query.dto.js';
import { TurbineListQueryDto } from './dto/turbine-list-query.dto.js';

export type { FarmOverview, TurbineOverview } from '@nextera/shared';

/**
 * The fleet read endpoints (the shared queries in `@nextera/shared`, with 404 for an unknown
 * turbine) and the turbine's commissioned flag.
 */
@Injectable()
export class FleetService {
  private readonly logger = new Logger(FleetService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventStore,
    private readonly farmsCache: FarmsCacheService,
  ) {}

  /**
   * Every farm with its turbines and each turbine's latest reading: the fleet overview.
   * DEPRECATED: 413 above 5,000 turbines (checked before anything is loaded).
   */
  overview(): Promise<FarmOverview[]> {
    return httpQuery(listFarms(this.prisma));
  }

  /** `overview()` as cached JSON bytes + ETag (see FarmsCacheService); what GET /api/farms sends. */
  cachedOverview(): Promise<CachedBody> {
    return this.farmsCache.get(() => this.overview());
  }

  /** GET /api/farm-summaries as cached JSON bytes + ETag: every farm with live totals. */
  cachedFarmSummaries(): Promise<CachedBody> {
    return this.farmsCache.getKeyed('farm-summaries', () =>
      listFarmSummaries(this.prisma),
    );
  }

  /** GET /api/fleet/summary as cached JSON bytes + ETag: the fleet's live totals. */
  cachedFleetSummary(): Promise<CachedBody> {
    return this.farmsCache.getKeyed('fleet-summary', () =>
      fleetSummary(this.prisma),
    );
  }

  /** One page of turbines with their latest readings; 400 for a bad cursor or an unsupported sort. */
  turbines(query: TurbineListQueryDto): Promise<TurbineListResponse> {
    const { asOf, ...rest } = query;
    return httpQuery(
      listTurbines(this.prisma, {
        ...rest,
        now: asOf ? new Date(asOf) : undefined,
      }),
    );
  }

  /** One turbine in the list's shape; 404 if unknown. */
  turbine(turbineId: string): Promise<TurbineListItem> {
    return httpQuery(turbineItem(this.prisma, turbineId));
  }

  /** A farm's turbines for its map (at most 2,000); 404 for an unknown farm. */
  markers(farmId: string): Promise<TurbineMarker[]> {
    return httpQuery(turbineMarkers(this.prisma, farmId));
  }

  /** A turbine's readings, newest first, within an optional time range. */
  telemetry(
    turbineId: string,
    query: TelemetryQueryDto,
  ): Promise<TelemetryResponse[]> {
    return httpQuery(turbineTelemetry(this.prisma, turbineId, query));
  }

  /**
   * Median, high and low of every metric over exactly the readings `telemetry()` returns for the
   * same query: [from, to) on measurement time, the newest `limit`. One aggregate query in Postgres.
   */
  telemetryStats(
    turbineId: string,
    query: TelemetryQueryDto,
  ): Promise<TelemetryStatsResponse> {
    return httpQuery(telemetryStats(this.prisma, turbineId, query));
  }

  /**
   * A farm's weather in [from, to): 30-minute buckets or local days in `timeZone` aggregated in
   * Postgres. 404 for an unknown farm, 400 for a reversed range, one over 31 days or an unknown
   * time zone.
   */
  weather(
    farmId: string,
    query: WeatherQueryDto,
  ): Promise<FarmWeatherResponse> {
    return httpQuery(farmWeather(this.prisma, farmId, query));
  }

  /** The weather of a turbine's current farm, with the turbine id. 404 for an unknown turbine. */
  turbineWeather(
    turbineId: string,
    query: WeatherQueryDto,
  ): Promise<TurbineWeatherResponse> {
    return httpQuery(turbineWeather(this.prisma, turbineId, query));
  }

  /**
   * A farm's daily candles (power summed, the rest averaged over its turbines) in [from, to),
   * local days in `timeZone`, from the farm rollups. 404 for an unknown farm, 400 for a reversed
   * range, one over 183 days or an unknown time zone.
   */
  dailyHistory(
    farmId: string,
    query: FarmDailyQueryDto,
  ): Promise<FarmDailyHistoryResponse> {
    return httpQuery(farmDailyHistory(this.prisma, farmId, query));
  }

  /**
   * Sets a turbine's commissioned flag. One conditional UPDATE, so of any number of concurrent
   * requests for the same value exactly one changes the row and publishes FLEET_CHANGED (a read
   * followed by a write would publish once per request). Nothing matched means the value was
   * already set (an idempotent 200, no event) or the turbine is unknown (404).
   */
  async setCommissioned(
    turbineId: string,
    commissioned: boolean,
  ): Promise<TurbineResponse> {
    const [updated] = await this.prisma.turbine.updateManyAndReturn({
      where: { turbineId, commissioned: { not: commissioned } },
      data: { commissioned },
    });
    if (updated) {
      this.farmsCache.invalidate(); // before the event: this instance's next read must see it
      await this.publishFleetChanged({ turbineId });
      return toTurbineResponse(updated);
    }
    const current = await this.prisma.turbine.findUnique({
      where: { turbineId },
    });
    if (!current) throw new NotFoundException(`Turbine ${turbineId} not found`);
    return toTurbineResponse(current);
  }

  /**
   * Called after the commit. A Redis failure is logged, not thrown: the change is stored, and
   * other clients catch up on their next load.
   */
  private async publishFleetChanged(event: FleetChangedEvent): Promise<void> {
    try {
      await this.events.publish(FLEET_CHANGED, event);
    } catch (error) {
      this.logger.error(
        `Could not publish ${FLEET_CHANGED} for ${event.turbineId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
