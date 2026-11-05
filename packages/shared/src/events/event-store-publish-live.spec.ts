import { ConfigService } from '@nestjs/config';
import { EventStore, PublishManyError, turbineChannel } from './event-store.js';

const { pipelines, state } = vi.hoisted(() => ({
  pipelines: [] as { cmds: unknown[][] }[],
  state: { results: [] as unknown[] },
}));

vi.mock('ioredis', () => ({
  Redis: class {
    pipeline() {
      const p = {
        cmds: [] as unknown[][],
        xadd: (...a: unknown[]) => (p.cmds.push(['xadd', ...a]), p),
        publish: (...a: unknown[]) => (p.cmds.push(['publish', ...a]), p),
        exec: () => Promise.resolve(state.results.shift()),
      };
      pipelines.push(p);
      return p;
    }
    quit() {
      return Promise.resolve();
    }
  },
}));

describe('turbineChannel', () => {
  it('is telemetry:<turbineId>', () => {
    expect(turbineChannel('TURB001')).toBe('telemetry:TURB001');
  });
});

describe('EventStore.publishLive', () => {
  const store = () =>
    new EventStore({
      getOrThrow: () => 'redis://x',
    } as unknown as ConfigService);
  beforeEach(() => {
    pipelines.length = 0;
    state.results = [];
  });

  it('PUBLISHes { type, data } to each channel in one pipeline, with no XADD', async () => {
    state.results = [
      [
        [null, 1],
        [null, 0],
      ],
    ];

    await store().publishLive([
      { channel: turbineChannel('TURB001'), type: 't', data: { a: 1 } },
      { channel: turbineChannel('TURB002'), type: 't', data: { a: 2 } },
    ]);

    expect(pipelines).toHaveLength(1);
    expect(pipelines[0].cmds).toEqual([
      [
        'publish',
        'telemetry:TURB001',
        JSON.stringify({ type: 't', data: { a: 1 } }),
      ],
      [
        'publish',
        'telemetry:TURB002',
        JSON.stringify({ type: 't', data: { a: 2 } }),
      ],
    ]);
  });

  it('does nothing for no events', async () => {
    await store().publishLive([]);
    expect(pipelines).toHaveLength(0);
  });

  it('throws PublishManyError with the count when some PUBLISHes fail', async () => {
    state.results = [
      [
        [null, 1],
        [new Error('READONLY'), undefined],
        [null, 1],
      ],
    ];

    const publish = store().publishLive(
      ['A', 'B', 'C'].map((id) => ({
        channel: turbineChannel(id),
        type: 't',
        data: id,
      })),
    );

    await expect(publish).rejects.toMatchObject({
      name: 'PublishManyError',
      failed: 1,
      total: 3,
    });
    await expect(publish).rejects.toBeInstanceOf(PublishManyError);
  });
});
