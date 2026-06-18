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
import { VERSION } from './version.js';

async function main() {
  // Claude Desktop runs this on its OWN bundled Node, not the user's system
  // Node. Log which version that is (read it in Claude Desktop's MCP logs),
  // and fail loudly with a human message instead of a cryptic SDK crash if
  // the runtime is too old.
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  console.error(`[jd-intel] runtime check: Node ${process.version} on ${process.platform}/${process.arch}`);
  if (nodeMajor < 18) {
    console.error(`[jd-intel] Needs Node 18 or newer, but this runtime is ${process.version}. If you installed via Claude Desktop, update Claude Desktop to the latest version and try again.`);
    process.exit(1);
  }

  const server = new McpServer({
    name: 'jd-intel',
    version: VERSION,
  });

  registerTools(server);
  registerResources(server);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Log to stderr so stdout stays clean for MCP protocol traffic
  console.error(`jd-intel MCP server ${VERSION} running on stdio`);
}

main().catch((err) => {
  console.error('Fatal error starting jd-intel MCP:', err);
  process.exit(1);
});
