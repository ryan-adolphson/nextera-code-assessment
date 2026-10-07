import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { EventStore, PrismaService, seedFromCsv } from '@nextera/shared';
import { SEED_DATA_DIR } from '@nextera/testing/seed-data';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';

export interface TestApp {
  app: NestExpressApplication;
  url: string;
  prisma: PrismaService;
  events: EventStore;
}

/**
 * Boots the worker with the same setup as main.ts on a random port, with farms and turbines from
 * the CSV seed and an empty telemetry table.
 */
export async function createTestApp(): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    logger: false,
    bodyParser: false, // configureApp sets it up, like main.ts
  });
  configureApp(app);
  await app.listen(0, '127.0.0.1');

  const prisma = app.get(PrismaService);
  await prisma.$executeRaw`TRUNCATE TABLE alert_history, telemetry, turbines, farms`;
  await seedFromCsv(prisma, SEED_DATA_DIR);
  await prisma.$executeRaw`TRUNCATE TABLE telemetry`;

  return { app, url: await app.getUrl(), prisma, events: app.get(EventStore) };
}
