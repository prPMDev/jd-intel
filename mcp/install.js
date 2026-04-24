/**
 * One-command installer for jd-intel-mcp in Claude Desktop.
 *
 * Usage: npx jd-intel-mcp install
 *
 * What it does:
 *   1. Detects the user's OS
 *   2. Locates Claude Desktop's config file
 *   3. Reads existing config (preserves other MCP servers)
 *   4. Adds or updates the jd-intel entry
 *   5. Writes back as valid JSON
 *   6. Prints next steps
 *
 * Prevents the "paste a snippet into existing config and break JSON" error
 * that hand-editing reliably produces.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir, platform } from 'node:os';

const PACKAGE_NAME = 'jd-intel-mcp';
const SERVER_KEY = 'jd-intel';

function configPathFor(os) {
  const home = homedir();
  switch (os) {
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
    case 'win32':
      return join(process.env.APPDATA || join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
    case 'linux':
      return join(home, '.config', 'Claude', 'claude_desktop_config.json');
    default:
      return null;
  }
}

export async function install() {
  const os = platform();
  const configPath = configPathFor(os);

  if (!configPath) {
    console.error(`Unsupported platform: ${os}. Supported: macOS, Windows, Linux.`);
    process.exit(1);
  }

  console.log(`Installing ${PACKAGE_NAME} in Claude Desktop config.`);
  console.log(`Config file: ${configPath}\n`);

  let config = {};
  let existed = false;

  if (existsSync(configPath)) {
    existed = true;
    const raw = await readFile(configPath, 'utf-8');
    try {
      config = JSON.parse(raw);
    } catch (err) {
      console.error('Your existing Claude Desktop config is not valid JSON.');
      console.error(`Fix it manually first, or back it up and run this again.`);
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
  } else {
    // Make sure the parent directory exists before writing
    await mkdir(dirname(configPath), { recursive: true });
    console.log('Config file did not exist — creating it.\n');
  }

  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }

  const alreadyInstalled = Boolean(config.mcpServers[SERVER_KEY]);

  config.mcpServers[SERVER_KEY] = {
    command: 'npx',
    args: ['-y', PACKAGE_NAME],
  };

  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  console.log(
    alreadyInstalled
      ? `Updated existing ${SERVER_KEY} entry.`
      : `Added ${SERVER_KEY} to mcpServers.`
  );

  const otherServers = Object.keys(config.mcpServers).filter((k) => k !== SERVER_KEY);
  if (otherServers.length > 0) {
    console.log(`Preserved other MCP servers: ${otherServers.join(', ')}`);
  }

  console.log('\nNext steps:');
  console.log('  1. Fully quit Claude Desktop (system tray → Quit on Windows, ⌘Q on macOS)');
  console.log('  2. Reopen Claude Desktop');
  console.log('  3. Start a new chat — jd-intel tools will be available');
  console.log('\nTry: "What fintech companies are in your jd-intel?"\n');
}

export async function uninstall() {
  const os = platform();
  const configPath = configPathFor(os);

  if (!configPath || !existsSync(configPath)) {
    console.log('No Claude Desktop config found. Nothing to uninstall.');
    return;
  }

  const raw = await readFile(configPath, 'utf-8');
  let config;
  try {
    config = JSON.parse(raw);
  } catch {
    console.error('Existing config is not valid JSON. Leaving it alone.');
    process.exit(1);
  }

  if (!config.mcpServers || !config.mcpServers[SERVER_KEY]) {
    console.log(`${SERVER_KEY} is not installed. Nothing to do.`);
    return;
  }

  delete config.mcpServers[SERVER_KEY];
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  console.log(`Removed ${SERVER_KEY} from Claude Desktop config.`);
  console.log('Restart Claude Desktop to complete the uninstall.');
}

export function printHelp() {
  console.log(`jd-intel-mcp — MCP server for searching jobs across ATS platforms

Usage:
  npx jd-intel-mcp            Start the MCP server (invoked by Claude Desktop)
  npx jd-intel-mcp install    Configure Claude Desktop to use this server
  npx jd-intel-mcp uninstall  Remove this server from Claude Desktop config
  npx jd-intel-mcp help       Show this help message
`);
}
