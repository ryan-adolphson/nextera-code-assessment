import { Injectable } from '@nestjs/common';
import {
  PrismaService,
  listAnomalies,
  type AnomaliesResponse,
} from '@nextera/shared';
import { httpQuery } from '../common/query-errors.js';
import { AnomaliesQueryDto } from './dto/anomalies-query.dto.js';

/** Anomaly episodes (low power in wind, stuck sensors), computed on read in Postgres. */
@Injectable()
export class AnomaliesService {
  constructor(private readonly prisma: PrismaService) {}

  /** The episodes in [from, to), newest end first; a reversed or over-31-day range is a 400. */
  list({ from, to }: AnomaliesQueryDto): Promise<AnomaliesResponse> {
    return httpQuery(listAnomalies(this.prisma, { from, to }));
  }
}
