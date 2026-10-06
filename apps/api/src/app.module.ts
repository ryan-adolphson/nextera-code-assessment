import { Module } from '@nestjs/common';
import { AlertConfigsModule } from './alert-configs/alert-configs.module.js';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation.js';
import { EventsModule } from './events/events.module.js';
import { HealthModule } from './health/health.module.js';
import { FleetModule } from './fleet/fleet.module.js';
import { EventStoreModule, PrismaModule } from '@nextera/shared';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      // One .env at the repo root; missing files are ignored and real env vars win (compose, Cloud Run).
      envFilePath: ['.env', '../../.env'],
      validate: validateEnv,
    }),
    PrismaModule,
    EventStoreModule,
    EventsModule,
    FleetModule,
    AlertConfigsModule,
    HealthModule,
  ],
})
export class AppModule {}
