import { Injectable } from '@nestjs/common';
import {
  PrismaService,
  anomaliesInRange,
  type AnomaliesResponse,
} from '@nextera/shared';
import { httpQuery } from '../common/query-errors.js';
import { AnomaliesQueryDto } from './dto/anomalies-query.dto.js';

/** Anomaly episodes (low power in wind, stuck sensors), stored hourly by the anomaly rollup (anomaly_episodes), read here. */
@Injectable()
export class AnomaliesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The episodes overlapping [from, to), clipped to it, newest end first; a reversed or
   * over-31-day range is a 400. See `anomaliesInRange` for how clipping differs from the old
   * on-read computation.
   */
  list({ from, to }: AnomaliesQueryDto): Promise<AnomaliesResponse> {
    return httpQuery(anomaliesInRange(this.prisma, { from, to }));
  }
}
