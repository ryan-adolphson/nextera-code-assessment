import {
  DEFAULT_TELEMETRY_LIMIT,
  MAX_TELEMETRY_LIMIT,
  timestampProblem,
  timestampProblemMessage,
} from '@nextera/shared';
import { z } from 'zod';
import { businessKey, timestamp } from './tool.js';
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
