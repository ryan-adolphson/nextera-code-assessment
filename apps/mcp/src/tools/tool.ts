import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  QueryError,
  timestampProblem,
  timestampProblemMessage,
  type ReadClient,
  type TelemetryResponse,
} from '@nextera/shared';
import { z } from 'zod';

/** What every tool gets: a read-only Prisma client and the clock (injectable for tests). */
export interface ToolContext {
  db: ReadClient;
  now: () => number;
}

/** One MCP tool: a zod input shape (validated by the SDK before `run`) and a JSON result. */
export interface Tool<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  inputSchema: Shape;
  run(ctx: ToolContext, args: z.infer<z.ZodObject<Shape>>): Promise<unknown>;
}

/** Keeps each tool's `args` typed by its own input shape. */
export const defineTool = <Shape extends z.ZodRawShape>(tool: Tool<Shape>) =>
  tool;

/** An error the tool reports to the model as it is (bad arguments beyond the input schema). */
export class ToolInputError extends Error {}

/** A timestamp argument: the same strict format as the API's from/to query bounds. */
export const timestamp = (field: string, description: string) =>
  z
    .string()
    .superRefine((value, ctx) => {
      const problem = timestampProblem(value, { allowFuture: true });
      if (problem) {
        ctx.addIssue({
          code: 'custom',
          message: timestampProblemMessage(problem, field),
        });
      }
    })
    .describe(
      `${description} ISO 8601 date-time with a time zone, e.g. 2026-01-01T00:00:00Z.`,
    );

/** A business key such as "TURB001" or "FARM01". */
export const businessKey = (description: string) =>
  z.string().trim().min(1).max(64).describe(description);

/** Runs a tool: its result as JSON text, or `isError` with a message the model can act on. */
export async function runTool(
  run: () => Promise<unknown>,
  log: (message: string) => void,
): Promise<CallToolResult> {
  try {
    const result = await run();
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (error) {
    if (error instanceof QueryError || error instanceof ToolInputError) {
      return errorResult(error.message);
    }
    log(
      `Tool failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
    );
    const message = error instanceof Error ? error.message : String(error);
    return errorResult(`The query failed: ${message.split('\n')[0]}`);
  }
}

export const errorResult = (message: string): CallToolResult => ({
  isError: true,
  content: [{ type: 'text', text: message }],
});

/** A rule a reading triggered, in one line: "error: gearboxTempC 126.5 above 120". */
export function describeAlerts(reading: TelemetryResponse): string[] {
  return reading.alerts.map(
    (rule) =>
      `${rule.alertLevel}: ${rule.measurementMetric} ${reading[rule.measurementMetric]} ` +
      `${rule.comparison} ${rule.valueMetric}${rule.enabled ? '' : ' (rule now disabled)'}`,
  );
}

/** A reading without ids, for the model: measurement and arrival time, values, triggered rules. */
export function compactReading(reading: TelemetryResponse) {
  return {
    timestamp: reading.timestamp,
    receivedAt: reading.receivedAt,
    powerOutputKw: reading.powerOutputKw,
    windSpeedMs: reading.windSpeedMs,
    rotorRpm: reading.rotorRpm,
    bladePitchDeg: reading.bladePitchDeg,
    gearboxTempC: reading.gearboxTempC,
    alerts: describeAlerts(reading),
  };
}
