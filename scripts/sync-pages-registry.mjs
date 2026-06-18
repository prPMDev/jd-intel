#!/usr/bin/env node
/**
 * Publish the registry to GitHub Pages.
 *
 * Copies registry/*.json into docs/registry/ so the network-first registry
 * (see src/registry.js) serves the current company list at
 * https://prpmdev.github.io/jd-intel/registry/<ats>.json. Run whenever
 * registry/ changes, then commit docs/registry/ so Pages redeploys.
 *
 * Usage: npm run sync:registry-pages
 */
import { readdir, mkdir, copyFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'registry');
const DEST = join(ROOT, 'docs', 'registry');

async function main() {
  await mkdir(DEST, { recursive: true });
  const files = (await readdir(SRC)).filter((f) => f.endsWith('.json'));
  if (files.length === 0) throw new Error(`no registry JSON files found in ${SRC}`);
  for (const f of files) {
    await copyFile(join(SRC, f), join(DEST, f));
  }
  console.log(`Synced ${files.length} registry file(s) to docs/registry/: ${files.join(', ')}`);
}

main().catch((err) => {
  console.error('sync-pages-registry failed:', err.message);
  process.exit(1);
});
