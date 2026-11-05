import { Controller, Get, Query } from '@nestjs/common';
import type { AlertsPage } from '@nextera/shared';
import { Roles } from '../auth/auth.decorators.js';
import { AlertsQueryDto } from './dto/alerts-query.dto.js';
import { AlertsService } from './alerts.service.js';

@Roles('viewer')
@Controller('alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  /**
   * GET /api/alerts?from=&to=&limit=&cursor=: a page (default 500, at most 1,000) of the readings
   * measured in [from, to) that triggered alert rules, each with its rules, newest first, and the
   * `nextCursor` of the next page.
   */
  @Get()
  list(@Query() query: AlertsQueryDto): Promise<AlertsPage> {
    return this.alerts.list(query);
  }
}
