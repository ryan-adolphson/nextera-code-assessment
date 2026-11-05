import { setTimeout as delay } from 'node:timers/promises';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { EventStore, PrismaService, seedFromCsv } from '@nextera/shared';
import { SEED_DATA_DIR } from '@nextera/testing/seed-data';
import { Redis } from 'ioredis';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';

/** A live reading event as ingestion PUBLISHes it to a turbine's channel. */
export interface LiveEvent {
  channel: string;
  type: string;
  // oxlint-disable-next-line no-explicit-any -- the TelemetryResponse, read field by field in tests
  data: any;
}

/**
 * Listens to every turbine channel (`telemetry:*`) like the API's scoped SSE will. Live events are
 * PUBLISHed with no stream entry, so this is the only way to see them.
 */
export class LiveCollector {
  private received: LiveEvent[] = [];

  private constructor(private readonly redis: Redis) {}

  static async start(): Promise<LiveCollector> {
    const collector = new LiveCollector(new Redis(process.env.REDIS_URL!));
    collector.redis.on('pmessage', (_pattern, channel, message) => {
      const { type, data } = JSON.parse(message) as Omit<LiveEvent, 'channel'>;
      collector.received.push({ channel, type, data });
    });
    await collector.redis.psubscribe('telemetry:*');
    return collector;
  }

  clear(): void {
    this.received = [];
  }

  /** The events received so far, once no new one has arrived for `settleMs`. */
  async events(settleMs = 150): Promise<LiveEvent[]> {
    let seen = -1;
    while (seen !== this.received.length) {
      seen = this.received.length;
      await delay(settleMs);
    }
    return [...this.received];
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => undefined);
  }
}

export interface TestApp {
  app: NestExpressApplication;
  url: string;
  prisma: PrismaService;
  events: EventStore;
  live: LiveCollector;
}

/**
 * Boots the worker with the same setup as main.ts on a random port, with farms and turbines from
 * the CSV seed, an empty telemetry table and no unallocated turbines.
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
  await prisma.$executeRaw`TRUNCATE TABLE turbine_latest, farm_live_summary, anomaly_episodes, telemetry_alerts, telemetry, held_telemetry, unallocated_turbines, turbines, farm_weather, farm_telemetry_rollups, farms`;
  await seedFromCsv(prisma, SEED_DATA_DIR);
  await prisma.$executeRaw`TRUNCATE TABLE turbine_latest, telemetry_alerts, telemetry`;

  const live = await LiveCollector.start();
  const close = app.close.bind(app);
  app.close = async () => {
    await live.close();
    return close();
  };

  return {
    app,
    url: await app.getUrl(),
    prisma,
    events: app.get(EventStore),
    live,
  };
}
