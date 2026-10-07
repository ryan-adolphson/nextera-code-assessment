import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  PrismaService,
  TELEMETRY_ALERTS_INCLUDE,
  toTelemetryResponse,
  type TelemetryResponse,
} from '@nextera/shared';
import { assertRange } from '../common/date-range.js';
import {
  MAX_REPORT_RANGE_DAYS,
  ReportQueryDto,
} from './dto/report-query.dto.js';

/** What a report is about: a whole farm or one turbine (business keys, as in every response). */
export interface ReportScope {
  kind: 'farm' | 'turbine';
  /** The farm id ("FARM01") or the turbine id ("TURB001"). */
  id: string;
  /** The farm's name ("Prairie Ridge"); for a turbine, its farm's name. */
  name: string;
  farmId: string;
}

/** GET /api/reports/telemetry. */
export interface TelemetryReport {
  scope: ReportScope;
  from: string;
  to: string;
  /** Every reading measured in [from, to), with its triggered rules; by turbine, then time. */
  readings: TelemetryResponse[];
}

/** Telemetry reports: all readings of a farm or a turbine over a range (proof of concept). */
@Injectable()
export class ReportsService {
  constructor(private readonly prisma: PrismaService) {}

  async telemetry(query: ReportQueryDto): Promise<TelemetryReport> {
    const scope = await this.scope(query);
    const { start, end } = assertRange(
      query.from,
      query.to,
      MAX_REPORT_RANGE_DAYS,
    );

    const readings = await this.prisma.telemetry.findMany({
      where: {
        ...(scope.kind === 'farm'
          ? { farmId: scope.id }
          : { turbineId: scope.id }),
        timestamp: { gte: start, lt: end },
      },
      orderBy: [{ turbineId: 'asc' }, { timestamp: 'asc' }],
      include: TELEMETRY_ALERTS_INCLUDE,
    });
    return {
      scope,
      from: start.toISOString(),
      to: end.toISOString(),
      readings: readings.map(toTelemetryResponse),
    };
  }

  /** Exactly one of farmId and turbineId, which must exist (404 otherwise). */
  private async scope({
    farmId,
    turbineId,
  }: ReportQueryDto): Promise<ReportScope> {
    if (!farmId === !turbineId) {
      throw new BadRequestException(
        'Provide exactly one of farmId or turbineId',
      );
    }
    if (farmId) {
      const farm = await this.prisma.farm.findUnique({
        where: { id: farmId },
        select: { id: true, name: true },
      });
      if (!farm) throw new NotFoundException(`Farm ${farmId} not found`);
      return { kind: 'farm', id: farm.id, name: farm.name, farmId: farm.id };
    }
    const turbine = await this.prisma.turbine.findUnique({
      where: { turbineId: turbineId! },
      select: {
        turbineId: true,
        farmId: true,
        farm: { select: { name: true } },
      },
    });
    if (!turbine) throw new NotFoundException(`Turbine ${turbineId} not found`);
    return {
      kind: 'turbine',
      id: turbine.turbineId,
      name: turbine.farm.name,
      farmId: turbine.farmId,
    };
  }
}
