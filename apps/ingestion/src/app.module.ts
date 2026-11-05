import { Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { TerminusModule } from '@nestjs/terminus';
import { EventStoreModule, PrismaModule } from '@nextera/shared';
import { validateEnv } from './config/env.validation.js';
import { HealthController } from './health/health.controller.js';
import { CsvUploadController } from './ingestion/csv-upload.controller.js';
import { AlertRulesCache } from './ingestion/alert-rules-cache.js';
import { QueueFullFilter } from './ingestion/queue-full.exception.js';
import { TelemetryBatcher } from './ingestion/telemetry-batcher.js';
import { TelemetryIngestionService } from './ingestion/telemetry-ingestion.service.js';
import { PubSubController } from './pubsub/pubsub.controller.js';

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
    TerminusModule,
  ],
  controllers: [PubSubController, CsvUploadController, HealthController],
  providers: [
    TelemetryIngestionService,
    TelemetryBatcher,
    AlertRulesCache,
    { provide: APP_FILTER, useClass: QueueFullFilter },
  ],
})
export class AppModule {}
