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

switch (command) {
  case 'install': {
    const { install } = await import('./install.js');
    await install();
    break;
  }
  case 'uninstall': {
    const { uninstall } = await import('./install.js');
    await uninstall();
    break;
  }
  case 'help':
  case '-h':
  case '--help': {
    const { printHelp } = await import('./install.js');
    printHelp();
    break;
  }
  default: {
    // No command → start the MCP server.
    // This is the path Claude Desktop invokes via `npx -y jd-intel-mcp`.
    await import('./server.js');
  }
}
