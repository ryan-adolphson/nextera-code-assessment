import { Injectable } from '@nestjs/common';
import { HealthIndicatorService } from '@nestjs/terminus';
import { EventStore } from '@nextera/shared';

@Injectable()
export class RedisHealthIndicator {
  constructor(
    private readonly indicator: HealthIndicatorService,
    private readonly events: EventStore,
  ) {}

  async isHealthy(key: string) {
    const check = this.indicator.check(key);
    try {
      await this.events.ping();
      return check.up();
    } catch (error) {
      return check.down({ message: (error as Error).message });
    }
  }
}
