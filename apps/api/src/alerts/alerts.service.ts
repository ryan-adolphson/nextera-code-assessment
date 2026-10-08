import { Injectable } from '@nestjs/common';
import {
  PrismaService,
  alertsInRange,
  type TelemetryResponse,
} from '@nextera/shared';
import { AlertsQueryDto } from './dto/alerts-query.dto.js';
import { httpQuery } from '../common/query-errors.js';

/** Telemetry alerts: the readings that triggered alert rules (telemetry_alerts), by time range. */
@Injectable()
export class AlertsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every reading measured in [from, to) that triggered at least one rule, with those rules
   * (joined from alerts_config, worst level first), grouped by turbine (turbine id ascending) and
   * newest first within a turbine. Disabled rules still show on the readings they flagged.
   * A reversed, empty or over-31-day range is a 400.
   */
  list({ from, to }: AlertsQueryDto): Promise<TelemetryResponse[]> {
    return httpQuery(alertsInRange(this.prisma, { from, to }));
  }
}
