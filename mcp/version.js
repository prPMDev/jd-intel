/**
 * Single source of the server version.
 *
 * Read from package.json via createRequire — works on every Node 18+ with no
 * import-attribute version concerns (Claude Desktop's bundled Node version is
 * not known ahead of time). server.js reports this to the MCP host; tools.js
 * surfaces it in response metadata so the AI can tell the user what's running.
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const VERSION = require('./package.json').version;
