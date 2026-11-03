import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import type {
  FarmDailyHistoryResponse,
  FarmWeatherResponse,
  TelemetryResponse,
  TelemetryStatsResponse,
  TurbineResponse,
  TurbineWeatherResponse,
} from '@nextera/shared';
import { Roles } from '../auth/auth.decorators.js';
import { jsonEtag } from '../common/etag.js';
import { FarmDailyQueryDto } from './dto/farm-daily-query.dto.js';
import { WeatherQueryDto } from './dto/weather-query.dto.js';
import { TelemetryQueryDto } from './dto/telemetry-query.dto.js';
import { UpdateTurbineDto } from './dto/update-turbine.dto.js';
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
   * GET /api/farms/:farmId/telemetry/daily?from=&to=&timeZone=: the farm's daily candles from the
   * farm rollups. `ETag` (a hash of the body) + `Cache-Control: private, no-cache`: private,
   * because the response depends on the Bearer token, so no shared cache may keep it; no-cache, so
   * the browser revalidates every time (a `max-age` let it answer the web's Refresh from its own
   * cache, hiding a new rollup run; the web keeps its own in-memory cache). A matching
   * `If-None-Match` gets 304 without a body (Express, once the ETag header is set).
   */
  @Get('farms/:farmId/telemetry/daily')
  async dailyHistory(
    @Param('farmId') farmId: string,
    @Query() query: FarmDailyQueryDto,
    @Res({ passthrough: true }) res: Response,
  ): Promise<FarmDailyHistoryResponse> {
    const body = await this.fleet.dailyHistory(farmId, query);
    res.setHeader('ETag', jsonEtag(body));
    res.setHeader('Cache-Control', 'private, no-cache');
    return body;
  }

  /**
   * GET /api/farms/:farmId/weather?from=&to=&interval=30min|daily&timeZone=: the farm's Open-Meteo
   * weather in [from, to) (at most 31 days), 30-minute buckets or local days in `timeZone`
   * (default UTC) aggregated from them.
   */
  @Get('farms/:farmId/weather')
  weather(
    @Param('farmId') farmId: string,
    @Query() query: WeatherQueryDto,
  ): Promise<FarmWeatherResponse> {
    return this.fleet.weather(farmId, query);
  }

  /**
   * PATCH /api/turbines/:id { commissioned }: marks a turbine commissioned or not. Owner and up
   * (the handler's @Roles overrides the controller's). Returns the updated turbine.
   */
  @Roles('owner')
  @Patch('turbines/:id')
  updateTurbine(
    @Param('id') id: string,
    @Body() dto: UpdateTurbineDto,
  ): Promise<TurbineResponse> {
    return this.fleet.setCommissioned(id, dto.commissioned);
  }

  /**
   * GET /api/turbines/:id/weather?from=&to=&interval=30min|daily&timeZone=: the weather of the
   * turbine's current farm (the farm endpoint's body plus `turbineId`); 404 for an unknown turbine.
   */
  @Get('turbines/:id/weather')
  turbineWeather(
    @Param('id') id: string,
    @Query() query: WeatherQueryDto,
  ): Promise<TurbineWeatherResponse> {
    return this.fleet.turbineWeather(id, query);
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
