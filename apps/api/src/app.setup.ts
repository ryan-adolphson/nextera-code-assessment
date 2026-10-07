import { ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { NestExpressApplication } from '@nestjs/platform-express';
import helmet from 'helmet';
import { PrismaExceptionFilter } from './common/prisma-exception.filter.js';

export const CORS_METHODS = ['GET', 'HEAD', 'POST', 'PATCH', 'DELETE'];
export const CORS_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  'Last-Event-ID',
];

/** Global app setup, shared by main.ts and the e2e tests so both behave identically. */
export function configureApp(
  app: NestExpressApplication,
): NestExpressApplication {
  app.set('trust proxy', true); // behind the Cloud Run front end
  // The Angular app (Cloud Run nextera-web) is on another origin, so resources must be cross-origin readable.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.enableCors({
    origin: corsOrigins(app.get(ConfigService).get<string>('CORS_ORIGINS', '')),
    // Authorization: the Bearer access token (a header, not a cookie, so no `credentials`).
    // Writes: alert configs (JSON bodies, so preflighted for Content-Type). Last-Event-ID:
    // EventSource reconnects. Telemetry itself arrives through the ingestion worker.
    methods: CORS_METHODS,
    allowedHeaders: CORS_ALLOWED_HEADERS,
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
