import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { PrismaExceptionFilter } from './common/prisma-exception.filter.js';

/** Global app setup, shared by main.ts and the e2e tests so both behave identically. */
export function configureApp(
  app: NestExpressApplication,
): NestExpressApplication {
  app.set('trust proxy', true); // behind the Cloud Run front end
  // The Angular app (Cloud Run nextera-web) is on another origin, so resources must be cross-origin readable.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.enableCors({
    origin: corsOrigins(app.get(ConfigService).get<string>('CORS_ORIGINS', '')),
    methods: ['GET'], // read-only API; telemetry arrives through the ingestion worker
    maxAge: 3600, // cache preflights for an hour
  });
  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  app.useGlobalFilters(new PrismaExceptionFilter());
  app.enableShutdownHooks(); // SIGTERM from Cloud Run / docker stop -> close streams, DB and Redis
  return app;
}

export function corsOrigins(value: string): string[] {
  return value
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}
