import { Controller, Get, Query } from '@nestjs/common';
import type { TelemetryResponse } from '@nextera/shared';
import { Roles } from '../auth/auth.decorators.js';
import { AlertsQueryDto } from './dto/alerts-query.dto.js';
import { AlertsService } from './alerts.service.js';

@Roles('viewer')
@Controller('alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  /**
   * GET /api/alerts?from=&to=: the readings measured in [from, to) that triggered alert rules,
   * each with its rules, grouped by turbine and newest first.
   */
  @Get()
  list(@Query() query: AlertsQueryDto): Promise<TelemetryResponse[]> {
    return this.alerts.list(query);
  }
}
