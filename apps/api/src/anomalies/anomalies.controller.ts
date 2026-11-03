import { Controller, Get, Query } from '@nestjs/common';
import type { AnomaliesResponse } from '@nextera/shared';
import { Roles } from '../auth/auth.decorators.js';
import { AnomaliesService } from './anomalies.service.js';
import { AnomaliesQueryDto } from './dto/anomalies-query.dto.js';

@Roles('viewer')
@Controller('anomalies')
export class AnomaliesController {
  constructor(private readonly anomalies: AnomaliesService) {}

  /** GET /api/anomalies?from=&to=: anomaly episodes in [from, to) with the estimated lost output. */
  @Get()
  list(@Query() query: AnomaliesQueryDto): Promise<AnomaliesResponse> {
    return this.anomalies.list(query);
  }
}
