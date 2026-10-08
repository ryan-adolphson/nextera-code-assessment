import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ReadClient } from '@nextera/shared';
import { TOOLS } from './tools/index.js';
import { runTool, type ToolContext } from './tools/tool.js';

export const SERVER_NAME = 'nextera';
export const SERVER_VERSION = '0.0.1';

export interface ServerOptions {
  /** The clock for staleness (default Date.now). */
  now?: () => number;
  /** Diagnostics; never stdout, which carries the protocol (default stderr). */
  log?: (message: string) => void;
}

const INSTRUCTIONS =
  'Read-only access to the Nextera wind-farm fleet: farms → turbines → telemetry every 5 ' +
  'minutes (power kW, wind m/s, rotor rpm, blade pitch °, gearbox °C), the alert rules and the ' +
  'readings they flagged. Ids are business keys ("FARM01", "TURB001"). Times are UTC ISO 8601 ' +
  'with a zone; ranges are [from, to) on measurement time. Start with list_farms.';

/** The MCP server with every fleet tool registered on `db` (a read-only client in production). */
export function createServer(
  db: ReadClient,
  {
    now = Date.now,
    log = (message) => process.stderr.write(`${message}\n`),
  }: ServerOptions = {},
): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: INSTRUCTIONS },
  );
  const ctx: ToolContext = { db, now };
  for (const tool of TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      (args: Record<string, unknown>) =>
        runTool(() => tool.run(ctx, args as never), log),
    );
  }
  return server;
}
