import { Injectable } from '@nestjs/common';
import {
  PrismaService,
  reportTelemetry,
  type TelemetryReport,
} from '@nextera/shared';
import { httpQuery } from '../common/query-errors.js';
import { ReportQueryDto } from './dto/report-query.dto.js';

export type { ReportScope, TelemetryReport } from '@nextera/shared';

/** Telemetry reports: all readings of a farm or a turbine over a range (proof of concept). */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Exactly one of farmId and turbineId (400 otherwise), which must exist (404), and a [from, to)
   * range of at most 31 days (400).
   */
  telemetry(query: ReportQueryDto): Promise<TelemetryReport> {
    return httpQuery(reportTelemetry(this.prisma, query));
  }
}
