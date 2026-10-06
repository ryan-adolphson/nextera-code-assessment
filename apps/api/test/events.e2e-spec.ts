import {
  createTestApp,
  openSse,
  publishReading,
  type TestApp,
} from './helpers.js';

describe('SSE events (e2e, real Redis)', () => {
  let t: TestApp;

  beforeAll(async () => {
    t = await createTestApp();
  });

  afterAll(async () => {
    await t.app.close();
  });

  it('streams text/event-stream with proxy buffering disabled', async () => {
    const sse = await openSse(`${t.url}/api/events`);
    try {
      expect(sse.response.status).toBe(200);
      expect(sse.response.headers.get('content-type')).toContain(
        'text/event-stream',
      );
      expect(sse.response.headers.get('x-accel-buffering')).toBe('no');
    } finally {
      sse.close();
    }
  });

  it('serves the stream cross-origin to the Angular app (CORS on SSE)', async () => {
    const sse = await openSse(`${t.url}/api/events`, {
      Origin: 'http://localhost:4200',
    });
    try {
      expect(sse.response.headers.get('access-control-allow-origin')).toBe(
        'http://localhost:4200',
      );
    } finally {
      sse.close();
    }
  });

  it('pushes telemetry.received with the Redis stream id', async () => {
    const sse = await openSse(`${t.url}/api/events`);
    try {
      const reading = await publishReading(t, { gearboxTempC: 126.5 });
      const event = await sse.nextEvent('telemetry.received');
      expect(event.id).toMatch(/^\d+-\d+$/);
      expect(JSON.parse(event.data)).toEqual(reading);
    } finally {
      sse.close();
    }
  });

  it('replays events missed while disconnected (Last-Event-ID), then continues live without duplicates', async () => {
    const first = await openSse(`${t.url}/api/events`);
    await publishReading(t);
    const lastSeen = await first.nextEvent('telemetry.received');
    first.close();

    const missedA = await publishReading(t, {
      turbineId: 'TURB002',
      farmId: 'FARM02',
    });
    const missedB = await publishReading(t);

    const resumed = await openSse(`${t.url}/api/events`, {
      'Last-Event-ID': lastSeen.id!,
    });
    try {
      const replayA = await resumed.nextEvent();
      const replayB = await resumed.nextEvent();
      expect([
        JSON.parse(replayA.data).id,
        JSON.parse(replayB.data).id,
      ]).toEqual([missedA.id, missedB.id]);

      const live = await publishReading(t);
      const liveEvent = await resumed.nextEvent();
      expect(JSON.parse(liveEvent.data).id).toBe(live.id);

      await expect(resumed.nextEvent(undefined, 500)).rejects.toThrow(
        'Timed out',
      ); // nothing delivered twice
    } finally {
      resumed.close();
    }
  });

  it('ignores a malformed Last-Event-ID and streams live', async () => {
    const sse = await openSse(`${t.url}/api/events`, {
      'Last-Event-ID': 'garbage',
    });
    try {
      const reading = await publishReading(t);
      expect(
        JSON.parse((await sse.nextEvent('telemetry.received')).data).id,
      ).toBe(reading.id);
    } finally {
      sse.close();
    }
  });

  it('fans out across API instances: an event published via Redis reaches clients on every instance', async () => {
    const instanceB = await createTestApp();
    const sseA = await openSse(`${t.url}/api/events`);
    const sseB = await openSse(`${instanceB.url}/api/events`);
    try {
      const reading = await publishReading(t);
      for (const sse of [sseA, sseB]) {
        expect(
          JSON.parse((await sse.nextEvent('telemetry.received')).data).id,
        ).toBe(reading.id);
      }
    } finally {
      sseA.close();
      sseB.close();
      await instanceB.app.close();
    }
  });
});
