#!/usr/bin/env node
// RelayPay support MCP server.
//
// Transport: stdio. The Claude Agent SDK spawns this as a child process.
// It is also independently runnable, which is the point — you can drive
// it with the MCP inspector without any of the agent or voice stack:
//
//   npm run build --workspace=@relaypay/mcp-server
//   npx @modelcontextprotocol/inspector node packages/mcp-server/dist/index.js
//
// IMPORTANT: stdout belongs to the protocol. Every diagnostic in this
// package writes to stderr. A stray console.log here corrupts the stream
// and the connection dies with a confusing parse error.

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from './json-schema.js';
import { TOOLS, TOOLS_BY_NAME } from './tools/index.js';
import type { ToolContext } from './instrument.js';

const server = new Server(
  { name: 'relaypay-support', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: zodToJsonSchema(t.schema)
  }))
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const tool = TOOLS_BY_NAME.get(name);

  if (!tool) {
    // Structured, not thrown. An unknown tool name is the model's
    // mistake to recover from, not a reason to drop the connection.
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
      isError: true
    };
  }

  // conversation_id travels in the tool arguments; the agent layer puts
  // it there. Tools that need it for foreign keys validate it themselves.
  const conversationId =
    typeof (args as Record<string, unknown> | undefined)?.conversation_id === 'string'
      ? ((args as Record<string, string>).conversation_id ?? null)
      : null;
  const ctx: ToolContext = { conversationId };

  // Handlers are already total — they catch internally and return
  // structured payloads. This try/catch is the last line of defence
  // against something truly unexpected (OOM, a bug in the wrapper).
  try {
    const result = await tool.handler(ctx, args ?? {});
    return { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[mcp] unhandled error in ${name}: ${message}`);
    return {
      content: [{ type: 'text', text: JSON.stringify({ error: 'Tool failed unexpectedly.', detail: message }) }],
      isError: true
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[mcp] relaypay-support ready on stdio');
}

main().catch((e) => {
  console.error(`[mcp] fatal: ${e instanceof Error ? e.message : e}`);
  process.exit(1);
});
