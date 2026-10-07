import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { AlertConfigsModule } from './alert-configs/alert-configs.module.js';
import { AlertsModule } from './alerts/alerts.module.js';
import { ReportsModule } from './reports/reports.module.js';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation.js';
import { EventsModule } from './events/events.module.js';
import { HealthModule } from './health/health.module.js';
import { FleetModule } from './fleet/fleet.module.js';
import { EventStoreModule, PrismaModule } from '@nextera/shared';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthModule } from './auth/auth.module.js';
import { RolesGuard } from './auth/roles.guard.js';

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
    AuthModule,
    EventsModule,
    FleetModule,
    AlertConfigsModule,
    AlertsModule,
    ReportsModule,
    HealthModule,
  ],
  providers: [
    // Default deny, in this order: AuthGuard (valid token, active user, else 401) then RolesGuard
    // (minimum role from @Roles, else 404). @Public() routes skip both.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
