import { ConfigService } from '@nestjs/config';
import {
  EVENT_CHANNEL,
  EVENT_STREAM_KEY,
  EventStore,
  PublishManyError,
} from './event-store.js';

const { pipelines, state } = vi.hoisted(() => ({
  pipelines: [] as { cmds: unknown[][]; results: unknown }[],
  state: { results: [] as unknown[] },
}));

vi.mock('ioredis', () => ({
  Redis: class {
    pipeline() {
      const p = {
        cmds: [] as unknown[][],
        results: undefined as unknown,
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

describe('EventStore.publishMany', () => {
  const store = () =>
    new EventStore({
      getOrThrow: () => 'redis://x',
    } as unknown as ConfigService);
  beforeEach(() => {
    pipelines.length = 0;
    state.results = [];
  });

  it('pipelines the XADDs, then the PUBLISHes, in order, with the stream ids', async () => {
    state.results = [
      [
        [null, '1-0'],
        [null, '1-1'],
      ],
      [
        [null, 1],
        [null, 1],
      ],
    ];

    const events = await store().publishMany([
      { type: 'a', data: 1 },
      { type: 'b', data: 2 },
    ]);

    expect(events).toEqual([
      { id: '1-0', type: 'a', data: 1 },
      { id: '1-1', type: 'b', data: 2 },
    ]);
    expect(pipelines).toHaveLength(2);
    expect(pipelines[0].cmds.map((c) => [c[0], c[1]])).toEqual([
      ['xadd', EVENT_STREAM_KEY],
      ['xadd', EVENT_STREAM_KEY],
    ]);
    expect(pipelines[1].cmds).toEqual([
      ['publish', EVENT_CHANNEL, JSON.stringify(events[0])],
      ['publish', EVENT_CHANNEL, JSON.stringify(events[1])],
    ]);
  });

  it('does nothing for an empty list', async () => {
    await expect(store().publishMany([])).resolves.toEqual([]);
    expect(pipelines).toHaveLength(0);
  });

  it('publishes the events that were stored and throws PublishManyError for a partial failure', async () => {
    state.results = [
      [
        [null, '1-0'],
        [new Error('OOM'), null],
      ],
      [[null, 1]],
    ];

    const error = await store()
      .publishMany([
        { type: 'a', data: 1 },
        { type: 'b', data: 2 },
      ])
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(PublishManyError);
    expect(error).toMatchObject({ failed: 1, total: 2 });
    expect((error as Error).message).toContain('OOM');
    expect(pipelines[1].cmds).toHaveLength(1); // the stored one still went out
  });
});
