import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';

/** Global app setup, shared by main.ts and the e2e tests so both behave identically. */
export function configureApp(
  app: NestExpressApplication,
): NestExpressApplication {
  // Pub/Sub sends the full message in one body; allow larger payloads than Express' 100kb default.
  app.useBodyParser('json', { limit: '10mb' });
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  app.enableShutdownHooks(); // SIGTERM from Cloud Run / docker stop -> finish in-flight work, close DB and Redis
  return app;
}
