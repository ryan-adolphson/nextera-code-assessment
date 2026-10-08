import { DEFAULT_TELEMETRY_LIMIT, MAX_TELEMETRY_LIMIT } from '@nextera/shared';
import { z } from 'zod';
import { timestamp } from './tool.js';

/** from/to/limit as GET /api/turbines/:id/telemetry takes them. */
export const telemetryWindow = {
  from: timestamp(
    'from',
    'Inclusive lower bound on measurement time.',
  ).optional(),
  to: timestamp(
    'to',
    'Exclusive upper bound on measurement time (may be in the future).',
  ).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_TELEMETRY_LIMIT)
    .default(DEFAULT_TELEMETRY_LIMIT)
    .describe(
      `The newest N readings of the window (default ${DEFAULT_TELEMETRY_LIMIT} = 24 h at one ` +
        `reading per 5 minutes, max ${MAX_TELEMETRY_LIMIT} = 7 days).`,
    ),
};
