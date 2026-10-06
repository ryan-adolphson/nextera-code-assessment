import { ConsoleLogger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    // JSON logs in production become structured entries in Cloud Logging.
    logger: new ConsoleLogger({ json: process.env.NODE_ENV === 'production' }),
    // Don't let open SSE connections block shutdown.
    forceCloseConnections: true,
  });
  configureApp(app);

  const port = app.get(ConfigService).get<number>('PORT', 3000);
  await app.listen(port, '0.0.0.0');
}

await bootstrap();
