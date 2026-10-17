/**
 * jd-intel MCP server on Cloudflare Workers (issue #30).
 *
 * Same tools, resources and envelope as server.js; only the transport
 * differs. One stateless server per request, JSON responses, no sessions:
 * the tools hold no state, so there is nothing a session would carry.
 *
 * Deploy: npx wrangler deploy (from mcp/). Add https://<worker>/mcp in
 * Claude as a custom connector.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { registerTools } from './tools.js';
import { registerResources } from './resources.js';
import { VERSION } from './version.js';

export default {
  async fetch(request) {
    if (new URL(request.url).pathname !== '/mcp') {
      return new Response(`jd-intel MCP server ${VERSION}. Connect an MCP client to /mcp.`, { status: 404 });
    }
    const server = new McpServer({ name: 'jd-intel', version: VERSION });
    registerTools(server);
    registerResources(server);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
};
