import { Controller, Get, Param, Query } from '@nestjs/common';
import type {
  FarmWeatherResponse,
  TelemetryResponse,
  TelemetryStatsResponse,
} from '@nextera/shared';
import { Roles } from '../auth/auth.decorators.js';
import { FarmWeatherQueryDto } from './dto/farm-weather-query.dto.js';
import { TelemetryQueryDto } from './dto/telemetry-query.dto.js';
import { FarmOverview, FleetService } from './fleet.service.js';

@Roles('viewer')
@Controller()
export class FleetController {
  constructor(private readonly fleet: FleetService) {}

  /** GET /api/farms: farms, their turbines and each turbine's latest reading. */
  @Get('farms')
  farms(): Promise<FarmOverview[]> {
    return this.fleet.overview();
  }

  /**
   * GET /api/farms/:farmId/weather?from=&to=&interval=hourly|daily: the farm's Open-Meteo weather
   * in [from, to) (at most 31 days), hourly rows or UTC days aggregated from them.
   */
  @Get('farms/:farmId/weather')
  weather(
    @Param('farmId') farmId: string,
    @Query() query: FarmWeatherQueryDto,
  ): Promise<FarmWeatherResponse> {
    return this.fleet.weather(farmId, query);
  }

  /** GET /api/turbines/:id/telemetry?from=&to=&limit= */
  @Get('turbines/:id/telemetry')
  telemetry(
    @Param('id') id: string,
    @Query() query: TelemetryQueryDto,
  ): Promise<TelemetryResponse[]> {
    return this.fleet.telemetry(id, query);
  }

  /**
   * GET /api/turbines/:id/telemetry/stats?from=&to=&limit=: median, high and low of every metric
   * over the same readings GET /api/turbines/:id/telemetry returns for the query.
   */
  @Get('turbines/:id/telemetry/stats')
  telemetryStats(
    @Param('id') id: string,
    @Query() query: TelemetryQueryDto,
  ): Promise<TelemetryStatsResponse> {
    return this.fleet.telemetryStats(id, query);
  }
}
