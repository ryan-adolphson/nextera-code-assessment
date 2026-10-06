import { Controller, Get } from '@nestjs/common';
import {
  HealthCheck,
  HealthCheckService,
  HealthIndicatorService,
  PrismaHealthIndicator,
} from '@nestjs/terminus';
import { EventStore, PrismaService } from '@nextera/shared';

@Controller('health')
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly indicator: HealthIndicatorService,
    private readonly prismaHealth: PrismaHealthIndicator,
    private readonly prisma: PrismaService,
    private readonly events: EventStore,
  ) {}

  /** Liveness: the process is up. No dependency checks. */
  @Get('live')
  live() {
    return { status: 'ok' };
  }

  /** Readiness: database and Redis are reachable. */
  @Get('ready')
  @HealthCheck()
  ready() {
    return this.health.check([
      () => this.prismaHealth.pingCheck('database', this.prisma),
      async () => {
        const check = this.indicator.check('redis');
        try {
          await this.events.ping();
          return check.up();
        } catch (error) {
          return check.down({ message: (error as Error).message });
        }
      },
    ]);
  }
}
