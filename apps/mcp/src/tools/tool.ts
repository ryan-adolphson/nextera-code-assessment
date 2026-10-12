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

/** A tool as its author writes it: `args` in `run` is typed by its own input shape. */
export interface ToolDefinition<Shape extends z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  /** The fields; `defineTool` makes them a strict object, so unknown arguments are rejected. */
  inputSchema: Shape;
  run(
    ctx: ToolContext,
    args: z.output<z.ZodObject<Shape, z.core.$strict>>,
  ): Promise<unknown>;
}

/** One MCP tool as the server registers it: its typed `run` is closed over by `defineTool`. */
export interface Tool {
  name: string;
  title: string;
  description: string;
  /**
   * A strict object: the SDK validates the arguments against it before `run`, and a key it
   * doesn't know (`form` for `from`) is an error naming that key instead of being dropped, which
   * would silently answer with the default window.
   */
  inputSchema: z.ZodObject<z.ZodRawShape, z.core.$strict>;
  run(ctx: ToolContext, args: unknown): Promise<unknown>;
}

/**
 * Builds a tool from its definition. `run` parses its arguments with the tool's own schema, which
 * is what types them: the list of tools needs no cast, and `run` can't be handed unvalidated
 * arguments. (Through the server the SDK has already rejected bad ones with the same schema.)
 */
export function defineTool<Shape extends z.ZodRawShape>(
  definition: ToolDefinition<Shape>,
): Tool {
  const inputSchema = z.strictObject(definition.inputSchema);
  return {
    name: definition.name,
    title: definition.title,
    description: definition.description,
    inputSchema,
    run: (ctx, args) => definition.run(ctx, inputSchema.parse(args)),
  };
}

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
    if (error instanceof z.ZodError) {
      return errorResult(`Invalid arguments: ${z.prettifyError(error)}`);
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
