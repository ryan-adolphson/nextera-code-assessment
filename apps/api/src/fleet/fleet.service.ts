import { Injectable } from '@nestjs/common';
import {
  PrismaService,
  farmDailyHistory,
  farmWeather,
  listFarms,
  telemetryStats,
  turbineTelemetry,
  turbineWeather,
  type FarmDailyHistoryResponse,
  type FarmOverview,
  type FarmWeatherResponse,
  type TelemetryResponse,
  type TelemetryStatsResponse,
  type TurbineWeatherResponse,
} from '@nextera/shared';
import { httpQuery } from '../common/query-errors.js';
import { FarmDailyQueryDto } from './dto/farm-daily-query.dto.js';
import { WeatherQueryDto } from './dto/weather-query.dto.js';
import { TelemetryQueryDto } from './dto/telemetry-query.dto.js';

export type { FarmOverview, TurbineOverview } from '@nextera/shared';

/** The fleet read endpoints: the shared queries (`@nextera/shared`), with 404 for an unknown turbine. */
@Injectable()
export class FleetService {
  constructor(private readonly prisma: PrismaService) {}

  /** Every farm with its turbines and each turbine's latest reading: the fleet overview. */
  overview(): Promise<FarmOverview[]> {
    return listFarms(this.prisma);
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
}
