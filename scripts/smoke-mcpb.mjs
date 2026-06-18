#!/usr/bin/env node
/**
 * Smoke-test the packed bundle (dist/jd-intel.mcpb).
 *
 * Tests the ARTIFACT, not the source: unpack it, boot the bundled server,
 * send one MCP `initialize` frame, and assert (a) the Node runtime probe
 * fired, (b) serverInfo.version matches the package, (c) `mcpb info` reports
 * the expected version and the (expected) unsigned status. Catches the
 * "works locally, breaks when packaged" class of bug.
 *
 * Usage: npm run smoke:mcpb   (run after npm run pack:mcpb)
 */
import { rm, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync, spawn } from 'node:child_process';
import assert from 'node:assert/strict';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const MCPB_FILE = join(DIST, 'jd-intel.mcpb');
const SMOKE = join(DIST, 'smoke');
const MCPB = '@anthropic-ai/mcpb@2.1.2';
const q = (p) => `"${p.replace(/\\/g, '/')}"`;

function safeJson(line) {
  try { return JSON.parse(line); } catch { return null; }
}

// Boot the bundled server, send initialize, resolve when the id:1 response
// lands on stdout (or after a timeout). Returns collected stdout + stderr.
function bootAndInit(serverPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = () => { if (!done) { done = true; child.kill(); resolve({ stdout, stderr }); } };
    const timer = setTimeout(finish, 6000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => {
      stdout += d;
      if (stdout.split('\n').some((l) => { const m = safeJson(l); return m && m.id === 1; })) {
        clearTimeout(timer);
        finish();
      }
    });
    const initFrame = JSON.stringify({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } },
    }) + '\n';
    child.stdin.write(initFrame);
  });
}

async function main() {
  if (!existsSync(MCPB_FILE)) throw new Error(`${MCPB_FILE} not found — run "npm run pack:mcpb" first`);
  const mcpPkg = JSON.parse(await readFile(join(ROOT, 'mcp', 'package.json'), 'utf-8'));

  await rm(SMOKE, { recursive: true, force: true });
  execSync(`npx -y ${MCPB} unpack ${q(MCPB_FILE)} ${q(SMOKE)}`, { cwd: ROOT, stdio: 'inherit' });

  // Packed manifest version matches the package (catches manifest drift).
  const packedManifest = JSON.parse(await readFile(join(SMOKE, 'manifest.json'), 'utf-8'));
  assert.equal(packedManifest.version, mcpPkg.version, `packed manifest version should be ${mcpPkg.version}`);

  // info: assert unsigned as a fact (the documented "allow unsigned" install path)
  const info = execSync(`npx -y ${MCPB} info ${q(MCPB_FILE)}`, { cwd: ROOT }).toString();
  assert.ok(/not signed/i.test(info), 'bundle is expected to be unsigned');

  // boot the unpacked server and initialize
  const { stdout, stderr } = await bootAndInit(join(SMOKE, 'server.js'));
  assert.match(stderr, /\[jd-intel\] runtime check: Node v/, 'runtime probe should log to stderr');
  const resp = stdout.split('\n').map(safeJson).find((m) => m && m.id === 1);
  assert.ok(resp && resp.result && resp.result.serverInfo, 'initialize should return a serverInfo result');
  assert.equal(resp.result.serverInfo.version, mcpPkg.version, `serverInfo.version should be ${mcpPkg.version}`);

  console.log(`\nsmoke ok: booted ${resp.result.serverInfo.name} ${resp.result.serverInfo.version}; probe fired; bundle reports ${mcpPkg.version}; unsigned as expected`);
}

main().catch((err) => {
  console.error('smoke-mcpb failed:', err.message);
  process.exit(1);
});
