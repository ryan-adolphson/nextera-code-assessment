import {
  FLEET_TICK,
  turbineChannel,
  type TelemetryResponse,
} from '@nextera/shared';
import { Redis } from 'ioredis';
import { TokenService } from '../src/auth/token.service.js';
import {
  createTestApp,
  eventsUrl,
  openSse,
  publishReading,
  type TestApp,
} from './helpers.js';

describe('SSE events (e2e, real Redis)', () => {
  let t: TestApp;
  let probe: Redis;

  beforeAll(async () => {
    t = await createTestApp();
    probe = new Redis(process.env.REDIS_URL!);
  });

  afterAll(async () => {
    await probe.quit();
    await t.app.close();
  });

  /** Subscribers of a turbine's channel, across instances (each API instance has one connection). */
  const subscribers = async (turbineId: string): Promise<number> => {
    const [, count] = (await probe.pubsub(
      'NUMSUB',
      turbineChannel(turbineId),
    )) as [string, number];
    return count;
  };
  const waitForSubscribers = async (turbineId: string, expected: number) => {
    await vi.waitFor(
      async () => {
        expect(await subscribers(turbineId)).toBe(expected);
      },
      { timeout: 3_000, interval: 25 },
    );
  };
  const scopedUrl = (turbines: string, role: 'viewer' | 'owner' = 'viewer') =>
    `${eventsUrl(t, role)}&turbines=${turbines}`;
  /** A live reading, published the way ingestion does (Redis PUBLISH only, no stream entry). */
  const publishLive = async (turbineId: string, n = 0) => {
    const reading = { turbineId, n } as unknown as TelemetryResponse;
    await t.events.publishLive([
      {
        channel: turbineChannel(turbineId),
        type: 'telemetry.received',
        data: reading,
      },
    ]);
    return reading;
  };

  it('streams text/event-stream with proxy buffering disabled', async () => {
    const sse = await openSse(eventsUrl(t));
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
    const sse = await openSse(eventsUrl(t), {
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
    const sse = await openSse(eventsUrl(t));
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
    const first = await openSse(eventsUrl(t));
    await publishReading(t);
    const lastSeen = await first.nextEvent('telemetry.received');
    first.close();

    const missedA = await publishReading(t, {
      turbineId: 'TURB002',
      farmId: 'FARM02',
    });
    const missedB = await publishReading(t);

    const resumed = await openSse(eventsUrl(t), {
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
    const sse = await openSse(eventsUrl(t), {
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
    const sseA = await openSse(eventsUrl(t));
    const sseB = await openSse(eventsUrl(instanceB));
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

  describe('scoped readings (?turbines=)', () => {
    it('delivers only the listed turbines, without an id, and still the global events', async () => {
      const sse = await openSse(scopedUrl('TURB001,TURB003'));
      try {
        await waitForSubscribers('TURB001', 1);
        await publishLive('TURB002', 1); // not listed
        await publishLive('TURB001', 2);
        const global = await t.events.publish('fleet.changed', {
          turbineId: 'X',
        });
        await publishLive('TURB003', 3);

        const first = await sse.nextEvent('telemetry.received');
        expect(JSON.parse(first.data)).toMatchObject({
          turbineId: 'TURB001',
          n: 2,
        });
        const fleet = await sse.nextEvent('fleet.changed');
        expect(fleet.id).toBe(global.id);
        const second = await sse.nextEvent('telemetry.received');
        expect(JSON.parse(second.data)).toMatchObject({
          turbineId: 'TURB003',
          n: 3,
        });
        // Never a counter id from the SSE writer: the global cursor, or empty.
        expect(first.id ?? '').toBe('');
        expect(second.id).toBe(global.id);
      } finally {
        sse.close();
      }
    });

    it('carries only global events without the param', async () => {
      const sse = await openSse(eventsUrl(t));
      try {
        await publishLive('TURB001');
        const tick = await t.events.publish(FLEET_TICK, {
          asOf: new Date().toISOString(),
        });
        const event = await sse.nextEvent();
        expect(event.event).toBe(FLEET_TICK);
        expect(event.id).toBe(tick.id);
        expect(await subscribers('TURB001')).toBe(0);
      } finally {
        sse.close();
      }
    });

    it('reference-counts channels across viewers and unsubscribes after the last leaves', async () => {
      const a = await openSse(scopedUrl('TURB001'));
      const b = await openSse(scopedUrl('TURB001,TURB002', 'owner'));
      try {
        await waitForSubscribers('TURB001', 1); // one connection per instance, not per viewer
        await waitForSubscribers('TURB002', 1);

        a.close();
        await waitForSubscribers('TURB001', 1); // b still views it
        await publishLive('TURB001', 7);
        expect(
          JSON.parse((await b.nextEvent('telemetry.received')).data).n,
        ).toBe(7);

        b.close();
        await waitForSubscribers('TURB001', 0);
        await waitForSubscribers('TURB002', 0);
      } finally {
        a.close();
        b.close();
      }
    });

    it('resumes with Last-Event-ID from the global stream; readings neither advance nor corrupt the cursor', async () => {
      const first = await openSse(scopedUrl('TURB001'));
      const seen = await t.events.publish('fleet.changed', { turbineId: 'A' });
      await first.nextEvent('fleet.changed');
      first.close();
      const missed = await t.events.publish('fleet.changed', {
        turbineId: 'B',
      });

      const resumed = await openSse(scopedUrl('TURB001'), {
        'Last-Event-ID': seen.id,
      });
      try {
        await waitForSubscribers('TURB001', 1);
        await publishLive('TURB001', 1);
        const replay = await resumed.nextEvent('fleet.changed');
        expect(replay.id).toBe(missed.id);
        // The reading after the replay repeats the cursor, so a reconnect resumes from it.
        const reading = await resumed.nextEvent('telemetry.received');
        expect(reading.id).toBe(missed.id);
        await expect(resumed.nextEvent(undefined, 400)).rejects.toThrow(
          'Timed out',
        );
      } finally {
        resumed.close();
      }
    });

    it('does not replay readings that were published while disconnected', async () => {
      await publishLive('TURB001', 4242);
      const sse = await openSse(scopedUrl('TURB001'), {
        'Last-Event-ID': '1-0',
      });
      try {
        await waitForSubscribers('TURB001', 1);
        const payloads: string[] = [];
        for (;;) {
          try {
            payloads.push((await sse.nextEvent(undefined, 400)).data);
          } catch {
            break;
          }
        }
        expect(payloads.some((d) => d.includes('4242'))).toBe(false);
      } finally {
        sse.close();
      }
    });

    it.each([
      [
        'more than 100 turbines',
        Array.from({ length: 101 }, (_, i) => `T${i}`).join(','),
      ],
      ['an empty entry', 'TURB001,,TURB002'],
      ['a bad id', 'TURB%3A001'],
    ])('answers 400 for %s', async (_name, turbines) => {
      const res = await fetch(scopedUrl(turbines));
      expect(res.status).toBe(400);
      await res.body?.cancel();
      expect(await subscribers('TURB001')).toBe(0);
    });

    it('accepts exactly 100 turbines', async () => {
      const ids = Array.from({ length: 100 }, (_, i) => `T${i}`);
      const sse = await openSse(scopedUrl(ids.join(',')));
      try {
        expect(sse.response.status).toBe(200);
        await waitForSubscribers('T99', 1);
      } finally {
        sse.close();
      }
      await waitForSubscribers('T99', 0);
    });

    it('still requires a token', async () => {
      const res = await fetch(`${t.url}/api/events?turbines=TURB001`);
      expect(res.status).toBe(401);
    });

    it('ends the stream at token expiry and unsubscribes', async () => {
      const user = await t.prisma.user.findUniqueOrThrow({
        where: { email: 'viewer@nextera.local' },
      });
      const now = new Date(Date.now() - 24 * 3600_000 + 1_500); // expires in ~1.5 s
      const { token } = await t.app.get(TokenService).sign(user, now);
      const response = await fetch(
        `${t.url}/api/events?access_token=${token}&turbines=TURB001`,
      );
      expect(response.status).toBe(200);
      await waitForSubscribers('TURB001', 1);
      const reader = response.body!.getReader();
      await vi.waitFor(
        async () => {
          const chunk = await reader.read();
          expect(chunk.done).toBe(true);
        },
        { timeout: 5_000, interval: 10 },
      );
      await waitForSubscribers('TURB001', 0);
    });

    it('unsubscribes on shutdown of an instance', async () => {
      const instance = await createTestApp();
      const sse = await openSse(
        scopedUrl('TURB004')
          .replace(t.url, instance.url)
          .replace(t.tokens.viewer, instance.tokens.viewer),
      );
      await waitForSubscribers('TURB004', 1);
      await instance.app.close();
      sse.close();
      await waitForSubscribers('TURB004', 0);
    });
  });
});
