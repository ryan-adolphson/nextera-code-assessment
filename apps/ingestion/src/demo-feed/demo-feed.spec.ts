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
    expect(published()).toHaveLength(DEMO_TURBINES.length - 1);
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
    expect(
      readings.every((r) => r.timestamp === '2026-10-08T12:05:00.000Z'),
    ).toBe(true);
    expect(readings.map((r) => r.turbine_id)).not.toContain(
      DEMO_ANOMALIES.stopped.turbineId,
    );
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
    expect(published()).toHaveLength(2 * (DEMO_TURBINES.length - 1));
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

  it('demoFeedReadings floors the time to the 5-minute boundary', () => {
    expect(demoFeedReadings(NOW)).toEqual(
      demoFeedReadings(Date.parse('2026-10-08T12:05:00Z')),
    );
  });
});
