import { Injectable } from '@nestjs/common';
import { PrismaService, alertsPage, type AlertsPage } from '@nextera/shared';
import { AlertsQueryDto } from './dto/alerts-query.dto.js';
import { httpQuery } from '../common/query-errors.js';

/** Telemetry alerts: the readings that triggered alert rules (telemetry_alerts), by time range. */
@Injectable()
export class AlertsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * A page of the readings measured in [from, to) that triggered at least one rule, with those
   * rules (joined from alerts_config, worst level first), newest first, plus `nextCursor` (null on
   * the last page). Disabled rules still show on the readings they flagged. A reversed, empty or
   * over-31-day range, or a bad cursor, is a 400.
   */
  list({ from, to, limit, cursor }: AlertsQueryDto): Promise<AlertsPage> {
    return httpQuery(alertsPage(this.prisma, { from, to, limit, cursor }));
  }
}
