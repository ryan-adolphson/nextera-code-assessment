import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from '../src/app.module.js';
import { configureApp } from '../src/app.setup.js';
import {
  EventStore,
  PrismaService,
  TELEMETRY_RECEIVED,
  type TelemetryResponse,
} from '@nextera/shared';
import { randomUUID } from 'node:crypto';

export interface TestApp {
  app: NestExpressApplication;
  url: string;
  prisma: PrismaService;
  events: EventStore;
}

/** Boots the real AppModule with the same global setup as main.ts, on a random port. */
export async function createTestApp(): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    forceCloseConnections: true,
    logger: false,
  });
  configureApp(app);
  await app.listen(0, '127.0.0.1'); // a real port: SSE needs streaming over HTTP
  return {
    app,
    url: await app.getUrl(),
    prisma: app.get(PrismaService),
    events: app.get(EventStore),
  };
}

/**
 * Publishes a telemetry.received event the way the ingestion worker does, so SSE tests exercise
 * the API's read side (Redis -> EventsService -> /api/events) without the worker.
 */
export function publishReading(
  t: TestApp,
  overrides: Partial<TelemetryResponse> = {},
): Promise<TelemetryResponse> {
  const reading: TelemetryResponse = {
    id: randomUUID(),
    turbineId: 'TURB001',
    farmId: 'FARM01',
    timestamp: new Date().toISOString(),
    receivedAt: new Date().toISOString(),
    powerOutputKw: 2100.5,
    windSpeedMs: 7.4,
    rotorRpm: 12.8,
    bladePitchDeg: 4.1,
    gearboxTempC: 79.6,
    alerts: [],
    ...overrides,
  };
  return t.events.publish(TELEMETRY_RECEIVED, reading).then(() => reading);
}

export interface SseMessage {
  id?: string;
  event?: string;
  data: string;
}

/**
 * Minimal SSE client over fetch. supertest can't be used: it waits for the response to end,
 * and an SSE response never ends.
 */
export async function openSse(
  url: string,
  headers: Record<string, string> = {},
) {
  const abort = new AbortController();
  const response = await fetch(url, { headers, signal: abort.signal });
  const reader = response
    .body!.pipeThrough(new TextDecoderStream())
    .getReader();
  const received: SseMessage[] = [];
  let buffer = '';

  const parse = (raw: string): SseMessage => {
    const message: SseMessage = { data: '' };
    for (const line of raw.split('\n')) {
      const [field, ...rest] = line.split(':');
      const value = rest.join(':').trimStart();
      if (field === 'id') message.id = value;
      else if (field === 'event') message.event = value;
      else if (field === 'data') message.data += value;
    }
    return message;
  };

  /** Resolves with the next message matching `predicate`, consuming it. */
  async function next(
    predicate: (m: SseMessage) => boolean,
    timeoutMs = 5_000,
  ): Promise<SseMessage> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = received.findIndex(predicate);
      if (index >= 0) return received.splice(index, 1)[0];

      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error('Timed out waiting for SSE message');
      const chunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('Timed out waiting for SSE message')),
            remaining,
          ),
        ),
      ]);
      if (chunk.done) throw new Error('SSE stream ended');

      buffer += chunk.value;
      let separator: number;
      while ((separator = buffer.indexOf('\n\n')) >= 0) {
        received.push(parse(buffer.slice(0, separator)));
        buffer = buffer.slice(separator + 2);
      }
    }
  }

  /** Next domain event (skips heartbeats). */
  const nextEvent = (type?: string, timeoutMs?: number) =>
    next(
      (m) => m.event !== 'ping' && (type === undefined || m.event === type),
      timeoutMs,
    );

  return {
    response,
    next,
    nextEvent,
    close: () => abort.abort(),
  };
}
