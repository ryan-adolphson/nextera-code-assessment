import { Injectable } from '@nestjs/common';
import {
  PrismaService,
  TELEMETRY_ALERTS_INCLUDE,
  toTelemetryResponse,
  type TelemetryResponse,
} from '@nextera/shared';
import {
  AlertsQueryDto,
  MAX_ALERTS_RANGE_DAYS,
} from './dto/alerts-query.dto.js';
import { assertRange } from '../common/date-range.js';

/** Telemetry alerts: the readings that triggered alert rules (telemetry_alerts), by time range. */
@Injectable()
export class AlertsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Every reading measured in [from, to) that triggered at least one rule, with those rules
   * (joined from alerts_config, worst level first), grouped by turbine (turbine id ascending) and
   * newest first within a turbine. Disabled rules still show on the readings they flagged.
   */
  async list({ from, to }: AlertsQueryDto): Promise<TelemetryResponse[]> {
    const { start, end } = assertRange(from, to, MAX_ALERTS_RANGE_DAYS);

    const readings = await this.prisma.telemetry.findMany({
      where: {
        timestamp: { gte: start, lt: end },
        alerts: { some: {} },
      },
      orderBy: [{ turbineId: 'asc' }, { timestamp: 'desc' }],
      include: TELEMETRY_ALERTS_INCLUDE,
    });
    return readings.map(toTelemetryResponse);
  }
}
