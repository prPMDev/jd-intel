/**
 * Single source of the server version: server.js reports it to the MCP
 * host, tools.js puts it in response metadata, worker.js serves it.
 *
 * A JSON import works on Node 18.20+ and on Cloudflare Workers alike. The
 * createRequire(import.meta.url) it replaces threw on Workers, where
 * import.meta.url is undefined.
 */
import pkg from './package.json' with { type: 'json' };

export const VERSION = pkg.version;
