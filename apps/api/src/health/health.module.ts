import { Module } from '@nestjs/common';
import { TerminusModule } from '@nestjs/terminus';
import { EventsModule } from '../events/events.module.js';
import { HealthController } from './health.controller.js';
import { RedisHealthIndicator } from './redis.health.js';

@Module({
  imports: [TerminusModule, EventsModule],
  controllers: [HealthController],
  providers: [RedisHealthIndicator],
})
export class HealthModule {}
