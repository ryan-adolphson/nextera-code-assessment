import { Controller, Get, Query } from '@nestjs/common';
import { ReportQueryDto } from './dto/report-query.dto.js';
import { ReportsService, type TelemetryReport } from './reports.service.js';

@Controller('reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}

  /**
   * GET /api/reports/telemetry?farmId=|turbineId=&from=&to=: every reading of the farm or turbine
   * measured in [from, to) (at most 31 days), with its triggered alert rules.
   */
  @Get('telemetry')
  telemetry(@Query() query: ReportQueryDto): Promise<TelemetryReport> {
    return this.reports.telemetry(query);
  }
}
