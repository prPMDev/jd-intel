#!/usr/bin/env node

/**
 * jd-intel MCP server — entry point.
 *
 * Exposes fetch_jobs, search_registry, and detect_ats as MCP tools,
 * plus the full company registry as a Resource, over stdio transport.
 *
 * Run locally:   node mcp/server.js
 * Via Claude Desktop config:
 *   {
 *     "mcpServers": {
 *       "jd-intel": {
 *         "command": "npx",
 *         "args": ["-y", "jd-intel-mcp"]
 *       }
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { registerTools } from './tools.js';
import { registerResources } from './resources.js';

async function main() {
  const server = new McpServer({
    name: 'jd-intel',
    version: '0.1.0',
  });

  registerTools(server);
  registerResources(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr so stdout stays clean for MCP protocol traffic
  console.error('jd-intel MCP server running on stdio');
}

main().catch((err) => {
  console.error('Fatal error starting jd-intel MCP:', err);
  process.exit(1);
});
