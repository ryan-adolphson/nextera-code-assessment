#!/usr/bin/env node
/**
 * The Nextera MCP server over stdio, started by the MCP client (.mcp.json, Claude Desktop):
 *   npm run build -w @nextera/mcp && node apps/mcp/dist/main.js
 * Reads MCP_DATABASE_URL, else DATABASE_URL (real env vars win over the repo-root .env). Every
 * connection is a read-only Postgres session. stdout carries only the protocol: logs go to stderr.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from 'dotenv';
import { createReadOnlyPrisma } from './prisma.js';
import { createServer } from './server.js';

const log = (message: string) =>
  process.stderr.write(`[nextera-mcp] ${message}\n`);
// A stray console.log would corrupt the JSON-RPC stream on stdout.
console.log = console.info = console.debug = console.error;

// The repo-root .env, found from this file (src/ or dist/), so the client's cwd doesn't matter.
config({
  path: [
    resolve('.env'),
    fileURLToPath(new URL('../../../.env', import.meta.url)),
  ],
  quiet: true,
});

const url = process.env.MCP_DATABASE_URL || process.env.DATABASE_URL;
if (!url) {
  log('Set MCP_DATABASE_URL or DATABASE_URL (e.g. in the repo-root .env).');
  process.exit(1);
}

const prisma = createReadOnlyPrisma(url);
const server = createServer(prisma, { log });

let closing = false;
async function shutdown(reason: string): Promise<void> {
  if (closing) return;
  closing = true;
  log(`Shutting down (${reason})`);
  await server.close().catch(() => undefined);
  await prisma.$disconnect().catch(() => undefined);
  process.exit(0);
}

process.stdin.on('end', () => void shutdown('stdin closed'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

await server.connect(new StdioServerTransport());
log(
  `Ready on stdio (database ${process.env.MCP_DATABASE_URL ? 'MCP_DATABASE_URL' : 'DATABASE_URL'}, read-only)`,
);
