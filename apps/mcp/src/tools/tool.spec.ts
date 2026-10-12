import {
  DEFAULT_TELEMETRY_LIMIT,
  MAX_TELEMETRY_LIMIT,
  timestampProblem,
  timestampProblemMessage,
} from '@nextera/shared';
import { z } from 'zod';
import {
  businessKey,
  defineTool,
  runTool,
  timestamp,
  type ToolContext,
} from './tool.js';
import { telemetryWindow } from './window.js';

describe('timestamp', () => {
  const from = timestamp('from', 'x');

  it.each(['2026-01-01T00:00:00Z', '2026-01-01T02:00:00+02:00'])(
    'accepts %s',
    (value) => {
      expect(from.safeParse(value)).toEqual({ success: true, data: value });
    },
  );

  it.each([
    ['a zone-less value', '2026-01-01T00:00:00'],
    ['a week date', '2026-W01-4'],
    ['an impossible date', '2026-02-30T00:00:00Z'],
  ])('rejects %s with the shared message', (_, value) => {
    const problem = timestampProblem(value, { allowFuture: true });
    expect(problem).toBeTruthy();

    const result = from.safeParse(value);

    expect(result.success).toBe(false);
    expect(result.error!.issues[0].message).toBe(
      timestampProblemMessage(problem!, 'from'),
    );
  });
});

describe('businessKey', () => {
  const key = businessKey('x');

  it('trims the value', () => {
    expect(key.safeParse(' TURB001 ')).toEqual({
      success: true,
      data: 'TURB001',
    });
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['over 64 characters', 'A'.repeat(65)],
  ])('rejects a key that is %s', (_, value) => {
    expect(key.safeParse(value).success).toBe(false);
  });
});

describe('telemetryWindow', () => {
  const window = z.object(telemetryWindow);

  it('defaults limit and leaves from/to unset', () => {
    const result = window.safeParse({});

    expect(result.success).toBe(true);
    expect(result.data!.limit).toBe(DEFAULT_TELEMETRY_LIMIT);
    expect(result.data!.from).toBeUndefined();
    expect(result.data!.to).toBeUndefined();
  });

  it('accepts MAX_TELEMETRY_LIMIT', () => {
    expect(window.safeParse({ limit: MAX_TELEMETRY_LIMIT }).data).toEqual({
      limit: MAX_TELEMETRY_LIMIT,
    });
  });

  it.each([
    ['0', 0],
    ['a fraction', 1.5],
    ['over the maximum', MAX_TELEMETRY_LIMIT + 1],
    ['a string (no coercion)', '12'],
  ])('rejects a limit that is %s', (_, limit) => {
    const result = window.safeParse({ limit });

    expect(result.success).toBe(false);
    expect(result.error!.issues[0].path).toEqual(['limit']);
  });
});

describe('defineTool', () => {
  const ctx = {} as ToolContext;
  const run = vi.fn(
    async (_: ToolContext, args: { turbineId: string; limit: number }) => args,
  );
  const tool = defineTool({
    name: 'probe',
    title: 'Probe',
    description: 'x',
    inputSchema: { turbineId: businessKey('x'), limit: telemetryWindow.limit },
    run,
  });

  beforeEach(() => run.mockClear());

  it('makes the shape a strict object: an unknown key is an issue naming it', () => {
    const result = tool.inputSchema.safeParse({
      turbineId: 'TURB001',
      form: '2026-01-01T00:00:00Z',
    });

    expect(result.success).toBe(false);
    expect(result.error!.issues).toEqual([
      expect.objectContaining({
        code: 'unrecognized_keys',
        keys: ['form'],
        message: 'Unrecognized key: "form"',
      }),
    ]);
  });

  it('runs with the parsed arguments (trimmed, defaults applied)', async () => {
    await expect(tool.run(ctx, { turbineId: ' TURB001 ' })).resolves.toEqual({
      turbineId: 'TURB001',
      limit: DEFAULT_TELEMETRY_LIMIT,
    });
  });

  it('never runs with arguments its schema rejects, even when called directly', async () => {
    const log = vi.fn<(message: string) => void>();

    const result = await runTool(
      async () => tool.run(ctx, { turbineId: 'TURB001', form: 'x' }),
      log,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: expect.stringContaining('Unrecognized key: "form"'),
      },
    ]);
    expect(run).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it('accepts no arguments at all for a tool without fields, and rejects stray ones', () => {
    const empty = defineTool({
      name: 'none',
      title: 'None',
      description: 'x',
      inputSchema: {},
      run: async () => null,
    });

    expect(empty.inputSchema.safeParse({}).success).toBe(true);
    expect(empty.inputSchema.safeParse({ farmId: 'FARM01' }).success).toBe(
      false,
    );
  });
});
