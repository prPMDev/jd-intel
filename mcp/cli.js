#!/usr/bin/env node

/**
 * Dispatcher entry point.
 *
 * - No args (default, how Claude Desktop invokes us) → start the MCP server
 * - "install" → set up Claude Desktop config
 * - "uninstall" → remove from Claude Desktop config
 * - "help" / "-h" / "--help" → show usage
 */

const [, , command] = process.argv;

// install.js export to run for a command; anything else starts the MCP
// server, the path Claude Desktop invokes via `npx -y jd-intel-mcp`.
const COMMANDS = { install: 'install', uninstall: 'uninstall', help: 'printHelp', '-h': 'printHelp', '--help': 'printHelp' };
const run = Object.hasOwn(COMMANDS, command ?? '') ? COMMANDS[command] : null;

if (run) await (await import('./install.js'))[run]();
else await import('./server.js');
