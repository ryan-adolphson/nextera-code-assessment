import {
  DEMO_ANOMALIES,
  DEMO_SEED,
  DEMO_TURBINES,
  generateTelemetry,
} from '@nextera/shared';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { IngestTelemetryDto } from '../ingestion/ingest-telemetry.dto.js';
import {
  DEMO_FEED_DISABLED_MESSAGE,
  demoFeedReadings,
  runDemoFeed,
  type DemoFeedDeps,
} from './demo-feed.js';

const NOW = Date.parse('2026-10-08T12:07:30Z'); // tick at 12:05

describe('demo feed', () => {
  const publishMessage = vi.fn();
  const topic = vi.fn(() => ({ publishMessage }));
  const close = vi.fn();
  const createPubSub = vi.fn(() => ({ topic, close }));
  const log = { log: vi.fn(), error: vi.fn() };
  const sleep = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    publishMessage.mockResolvedValue('message-id');
    close.mockResolvedValue(undefined);
    sleep.mockResolvedValue(undefined);
  });

  const run = (
    env: Record<string, string | undefined>,
    overrides: Partial<DemoFeedDeps> = {},
  ) =>
    runDemoFeed({
      env,
      argv: [],
      createPubSub,
      now: () => NOW,
      sleep,
      log,
      ...overrides,
    });
  const published = () =>
    publishMessage.mock.calls.map(([message]) => message.json);

  it.each([{}, { DEMO_FEED_ENABLED: 'false' }, { DEMO_FEED_ENABLED: '1' }])(
    'is disabled unless DEMO_FEED_ENABLED=true (%o): logs, exits 0, publishes nothing',
    async (env) => {
      await expect(run(env, { argv: ['--once'] })).resolves.toBe(0);
      expect(log.log).toHaveBeenCalledWith(DEMO_FEED_DISABLED_MESSAGE);
      expect(createPubSub).not.toHaveBeenCalled();
      expect(publishMessage).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ DEMO_FEED_ENABLED: 'true' }, ['--once']],
    [{ DEMO_FEED_ENABLED: 'true', DEMO_FEED_ONCE: 'true' }, []],
  ])('publishes one tick and exits with %o %o', async (env, argv) => {
    await expect(run(env, { argv })).resolves.toBe(0);

    expect(createPubSub).toHaveBeenCalledWith(undefined);
    expect(topic).toHaveBeenCalledWith('telemetry');
    expect(published()).toHaveLength(DEMO_TURBINES.length); // −TURB013, +TURB099
    expect(sleep).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('publishes valid payloads at the current 5-minute boundary, continuing the seed curve, without the stopped turbine', async () => {
    await run(
      {
        DEMO_FEED_ENABLED: 'true',
        PUBSUB_TOPIC: 'demo-topic',
        PUBSUB_EMULATOR_HOST: 'localhost:8085',
      },
      { argv: ['--once'] },
    );

    expect(createPubSub).toHaveBeenCalledWith('nextera-local');
    expect(topic).toHaveBeenCalledWith('demo-topic');
    const readings = published();
    const lagging = DEMO_ANOMALIES.lagging.map((l) => l.turbineId);
    expect(
      readings
        .filter((r) => !lagging.includes(r.turbine_id))
        .every((r) => r.timestamp === '2026-10-08T12:05:00.000Z'),
    ).toBe(true);
    expect(readings.map((r) => r.turbine_id)).not.toContain(
      DEMO_ANOMALIES.stopped.turbineId,
    );
    // The unallocated turbine: not in the fleet, one reading claiming FARM01.
    expect(DEMO_TURBINES.map((t) => t.turbineId)).not.toContain(
      DEMO_ANOMALIES.unallocated.turbineId,
    );
    expect(
      readings.filter(
        (r) => r.turbine_id === DEMO_ANOMALIES.unallocated.turbineId,
      ),
    ).toEqual([
      expect.objectContaining({
        turbine_id: 'TURB099',
        farm_id: 'FARM01',
        timestamp: '2026-10-08T12:05:00.000Z',
      }),
    ]);
    // Same values as the seed for that time; received_at is left to Pub/Sub's publishTime.
    const seeded = generateTelemetry({
      turbines: DEMO_TURBINES,
      end: Date.parse('2026-10-08T13:00:00Z'),
      hours: 2,
      seed: DEMO_SEED,
    }).find(
      (r) =>
        r.turbine_id === 'TURB003' &&
        r.timestamp === '2026-10-08T12:05:00.000Z',
    )!;
    const { received_at: _receivedAt, ...expected } = seeded;
    expect(readings).toContainEqual(expected);
    for (const reading of readings) {
      expect(reading).not.toHaveProperty('received_at');
      const dto = plainToInstance(IngestTelemetryDto, reading);
      expect(validateSync(dto, { forbidUnknownValues: true })).toEqual([]);
    }
  });

  it('loops every DEMO_FEED_INTERVAL_SECONDS until the signal aborts, then closes the client', async () => {
    const controller = new AbortController();
    let ticks = 0;
    sleep.mockImplementation(async () => {
      if (++ticks === 2) controller.abort(); // SIGTERM during the second wait
    });

    await expect(
      run(
        { DEMO_FEED_ENABLED: 'true', DEMO_FEED_INTERVAL_SECONDS: '60' },
        { signal: controller.signal },
      ),
    ).resolves.toBe(0);

    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(60_000, controller.signal);
    expect(published()).toHaveLength(2 * DEMO_TURBINES.length);
    expect(close).toHaveBeenCalledOnce();
  });

  it('keeps looping after a failed tick, but fails a --once run', async () => {
    publishMessage.mockRejectedValue(new Error('emulator down'));

    await expect(
      run({ DEMO_FEED_ENABLED: 'true' }, { argv: ['--once'] }),
    ).resolves.toBe(1);
    expect(log.error).toHaveBeenCalledWith(
      expect.stringContaining('emulator down'),
    );
    expect(close).toHaveBeenCalledOnce();

    const controller = new AbortController();
    sleep.mockImplementation(async () => controller.abort());
    await expect(
      run({ DEMO_FEED_ENABLED: 'true' }, { signal: controller.signal }),
    ).resolves.toBe(0);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('does not start when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    await run({ DEMO_FEED_ENABLED: 'true' }, { signal: controller.signal });
    expect(publishMessage).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(['0', '-5', '1.5', 'soon'])(
    'rejects DEMO_FEED_INTERVAL_SECONDS=%s',
    async (value) => {
      await expect(
        run({ DEMO_FEED_ENABLED: 'true', DEMO_FEED_INTERVAL_SECONDS: value }),
      ).resolves.toBe(1);
      expect(createPubSub).not.toHaveBeenCalled();
    },
  );

  describe('lagging and stopped turbines', () => {
    const timestampOf = (
      readings: { turbine_id: string; timestamp: string }[],
      id: string,
    ) => readings.filter((r) => r.turbine_id === id).map((r) => r.timestamp);
    // Ticks at various offsets inside a 5-minute step and across an hour.
    const ticks = [
      '2026-10-08T12:00:00Z',
      '2026-10-08T12:04:59.999Z',
      '2026-10-08T12:07:30Z',
      '2026-10-08T12:58:10Z',
      '2026-10-08T13:01:00Z',
    ];

    it.each(ticks)(
      'at %s publishes TURB011 20 min and TURB018 45 min behind the boundary, on a boundary',
      (tick) => {
        const readings = demoFeedReadings(Date.parse(tick));
        const boundary = Math.floor(Date.parse(tick) / 300_000) * 300_000;
        const iso = (minutesBack: number) =>
          new Date(boundary - minutesBack * 60_000).toISOString();
        expect(timestampOf(readings, 'TURB011')).toEqual([iso(20)]);
        expect(timestampOf(readings, 'TURB018')).toEqual([iso(45)]);
        expect(timestampOf(readings, 'TURB003')).toEqual([iso(0)]);
        // Staleness at the tick stays within its pill: (15, 30] and (30, 60] minutes.
        const age = (id: string) =>
          (Date.parse(tick) - Date.parse(timestampOf(readings, id)[0])) /
          60_000;
        expect(age('TURB011')).toBeGreaterThan(15);
        expect(age('TURB011')).toBeLessThan(30);
        expect(age('TURB018')).toBeGreaterThan(30);
        expect(age('TURB018')).toBeLessThan(60);
      },
    );

    it.each(ticks)('at %s never publishes the stopped TURB013', (tick) => {
      const readings = demoFeedReadings(Date.parse(tick));
      expect(DEMO_ANOMALIES.stopped.turbineId).toBe('TURB013');
      expect(timestampOf(readings, 'TURB013')).toEqual([]);
      // One per demo turbine but TURB013, plus TURB099.
      expect(readings).toHaveLength(DEMO_TURBINES.length);
      expect(new Set(readings.map((r) => r.turbine_id)).size).toBe(
        readings.length,
      );
    });

    it('continues the seeded curve of a lagging turbine (same values as the seed for that time)', () => {
      const readings = demoFeedReadings(Date.parse('2026-10-08T13:02:00Z'));
      // A seed ending at 13:00 stops TURB011 at 12:40; a later seed has the 12:40 reading too.
      const seeded = generateTelemetry({
        turbines: DEMO_TURBINES,
        end: Date.parse('2026-10-08T14:00:00Z'),
        hours: 2,
        seed: DEMO_SEED,
      });
      for (const id of ['TURB011', 'TURB018']) {
        const reading = readings.find((r) => r.turbine_id === id)!;
        const { received_at: _r, ...expected } = seeded.find(
          (r) => r.turbine_id === id && r.timestamp === reading.timestamp,
        )!;
        expect(reading).toEqual(expected);
      }
    });

    it('logs where the lagging turbines are', async () => {
      await run({ DEMO_FEED_ENABLED: 'true' }, { argv: ['--once'] });
      expect(log.log).toHaveBeenCalledWith(
        'Demo feed: published 25 readings for 2026-10-08T12:05:00.000Z ' +
          '(lagging: TURB011 at 2026-10-08T11:45:00.000Z, TURB018 at 2026-10-08T11:20:00.000Z) to telemetry',
      );
    });
  });

  it('demoFeedReadings floors the time to the 5-minute boundary', () => {
    expect(demoFeedReadings(NOW)).toEqual(
      demoFeedReadings(Date.parse('2026-10-08T12:05:00Z')),
    );
  });
});
