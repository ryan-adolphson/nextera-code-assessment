import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ReadClient } from '@nextera/shared';
import { createServer, type ServerOptions } from './server.js';

/** A connected SDK client and server over an in-memory transport (tests only). */
export async function connectClient(db: ReadClient, options?: ServerOptions) {
  const server = createServer(db, options);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'nextera-test', version: '0.0.0' });
  await Promise.all([
    server.connect(serverTransport),
    client.connect(clientTransport),
  ]);

  /** Calls a tool; returns its text, parsed as JSON unless the result is an error. */
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const [content] = result.content as { type: string; text: string }[];
    return {
      isError: result.isError === true,
      text: content.text,
      json: () => JSON.parse(content.text) as any,
    };
  };

  return {
    client,
    call,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}
