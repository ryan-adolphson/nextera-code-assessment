import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ALERT_CONFIG_CHANGED,
  EventStore,
  Prisma,
  PrismaService,
  toAlertConfigResponse,
  type AlertConfigChangedEvent,
  type AlertConfigResponse,
} from '@nextera/shared';
import {
  CreateAlertConfigDto,
  UpdateAlertConfigDto,
} from './dto/alert-config.dto.js';

/**
 * List order: metric (telemetry column order), then level severity (info, warn, error), then the
 * threshold value. Postgres sorts enums by declaration order, which is exactly that.
 */
const LIST_ORDER: Prisma.AlertConfigOrderByWithRelationInput[] = [
  { measurementMetric: 'asc' },
  { alertLevel: 'asc' },
  { valueMetric: 'asc' },
  { comparison: 'asc' },
  { id: 'asc' },
];

const isPrismaError = (error: unknown, code: string) =>
  error instanceof Prisma.PrismaClientKnownRequestError && error.code === code;

/** CRUD for alert thresholds (alerts_config). Every write publishes ALERT_CONFIG_CHANGED. */
@Injectable()
export class AlertConfigsService {
  private readonly logger = new Logger(AlertConfigsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventStore,
  ) {}

  async list(): Promise<AlertConfigResponse[]> {
    const rows = await this.prisma.alertConfig.findMany({
      orderBy: LIST_ORDER,
    });
    return rows.map(toAlertConfigResponse);
  }

  async get(id: string): Promise<AlertConfigResponse> {
    const row = await this.prisma.alertConfig.findUnique({ where: { id } });
    if (!row) throw notFound(id);
    return toAlertConfigResponse(row);
  }

  async create(dto: CreateAlertConfigDto): Promise<AlertConfigResponse> {
    const config = toAlertConfigResponse(
      await this.prisma.alertConfig
        .create({
          data: {
            measurementMetric: dto.measurementMetric,
            comparison: dto.comparison,
            valueMetric: dto.valueMetric,
            alertLevel: dto.alertLevel,
            enabled: dto.enabled, // undefined: the database default (true)
          },
        })
        .catch((error: unknown) => rethrow(error, dto)),
    );
    await this.publish({ action: 'created', id: config.id, config });
    return config;
  }

  async update(
    id: string,
    dto: UpdateAlertConfigDto,
  ): Promise<AlertConfigResponse> {
    const data = pick(dto);
    if (Object.keys(data).length === 0) {
      throw new BadRequestException(
        `Provide at least one of ${FIELDS.join(', ')}`,
      );
    }
    const row = await this.prisma.alertConfig
      .update({ where: { id }, data })
      .catch(async (error: unknown) => {
        // The conflicting rule is the merge of the stored row and the change.
        const current = isPrismaError(error, 'P2002')
          ? await this.prisma.alertConfig.findUnique({ where: { id } })
          : null;
        return rethrow(error, { ...current, ...data }, id);
      });
    const config = toAlertConfigResponse(row);
    await this.publish({ action: 'updated', id, config });
    return config;
  }

  /**
   * A rule that readings triggered cannot be deleted (telemetry_alerts RESTRICT, P2003): 409,
   * disable it instead.
   */
  async remove(id: string): Promise<void> {
    await this.prisma.alertConfig
      .delete({ where: { id } })
      .catch((error: unknown) => {
        if (isPrismaError(error, 'P2003')) {
          throw new ConflictException(
            `Alert config ${id} has triggered alerts on telemetry readings and cannot be deleted; disable it instead (enabled: false)`,
          );
        }
        return rethrow(error, {}, id);
      });
    await this.publish({ action: 'deleted', id });
  }

  /**
   * Called after the write committed. A Redis failure is logged, not thrown: the change is stored
   * and the caller refreshes anyway, so failing the request would only invite a duplicate retry.
   */
  private async publish(event: AlertConfigChangedEvent): Promise<void> {
    try {
      await this.events.publish(ALERT_CONFIG_CHANGED, event);
    } catch (error) {
      this.logger.error(
        `Could not publish ${ALERT_CONFIG_CHANGED} for ${event.id}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}

const FIELDS = [
  'measurementMetric',
  'comparison',
  'valueMetric',
  'alertLevel',
  'enabled',
] as const;

/** The fields present in a partial update (the DTO is whitelisted; this drops undefined). */
function pick(dto: UpdateAlertConfigDto): UpdateAlertConfigDto {
  return Object.fromEntries(
    FIELDS.filter((key) => dto[key] !== undefined).map((key) => [
      key,
      dto[key],
    ]),
  );
}

function notFound(id: string) {
  return new NotFoundException(`Alert config ${id} not found`);
}

/** P2002 → 409 naming the duplicate rule, P2025 → 404; anything else to the global filter. */
function rethrow(
  error: unknown,
  rule: Partial<CreateAlertConfigDto>,
  id?: string,
): never {
  if (isPrismaError(error, 'P2002')) {
    throw new ConflictException(
      `An alert rule for ${rule.measurementMetric} ${rule.comparison} at level ${rule.alertLevel} already exists`,
    );
  }
  if (id && isPrismaError(error, 'P2025')) throw notFound(id);
  throw error;
}
