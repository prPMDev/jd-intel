#!/usr/bin/env node
/**
 * Apply one reviewed item from tmp/registry-review.json (issue #87).
 *
 * append-registry.mjs sets aside every survivor that collides with an
 * existing slug, name or company key. A maintainer reads both boards,
 * decides what the collision is, and applies it here. This is the only
 * script that edits an existing row, and it does so in two ways only:
 *
 *   --as second-board --company "Acme"
 *       The candidate and the rows it collides with are boards of one
 *       company. Appends the candidate and writes `company` on all of them.
 *   --as migration [--existing N]
 *       The existing row's board is gone and the candidate replaces it.
 *       Removes collision N (default 0) and appends the candidate.
 *   --as stranger --name "Acme Robotics"
 *       A different company with the same name. Appends the candidate under
 *       a disambiguated name; nothing is linked.
 *
 * Usage:
 *   node scripts/link-registry.mjs --item 0 --as second-board --company "Acme"
 *   node scripts/link-registry.mjs --review tmp/registry-review.json --item 2 --as stranger --name "Acme Robotics"
 */

import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadRegistryFiles, writeRegistryFile, applyReview } from './registry-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_DIR = join(ROOT, 'registry');

const string = { type: 'string' };
const { values: flags } = parseArgs({
  options: { review: { type: 'string', default: 'tmp/registry-review.json' }, item: string, as: string, company: string, name: string, existing: { type: 'string', default: '0' } },
});

async function main() {
  const reviewFile = join(ROOT, flags.review);
  const review = JSON.parse(await readFile(reviewFile, 'utf-8'));
  const item = review.items?.[Number(flags.item)];
  if (flags.item === undefined || !item) throw new Error(`--item must be 0 to ${(review.items?.length ?? 0) - 1}`);
  if (item.applied) throw new Error(`item ${flags.item} was already applied as ${item.applied}`);

  const registry = await loadRegistryFiles(REGISTRY_DIR);
  const touched = applyReview(registry, item, { as: flags.as, company: flags.company, name: flags.name, existing: Number(flags.existing) });
  for (const ats of touched) await writeRegistryFile(REGISTRY_DIR, ats, registry[ats]);

  item.applied = flags.as;
  await writeFile(reviewFile, JSON.stringify(review, null, 2) + '\n');
  console.log(`Applied item ${flags.item} (${item.ats}/${item.candidate.slug}) as ${flags.as}. Rewrote: ${touched.map((a) => `registry/${a}.json`).join(', ')}`);
  console.log('Next: npm run sync:registry-pages && node --test test/*.test.js');
}

main().catch((err) => {
  console.error('link-registry failed:', err.message);
  process.exit(1);
});
