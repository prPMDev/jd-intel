#!/usr/bin/env node
/**
 * Registry appender — writes the survivors of a verify-registry.mjs
 * --candidates run into registry/*.json.
 *
 * Pairs with verify-registry.mjs: that script gates (live API check),
 * this one appends. It reads survivorsByAts from the verify report, so
 * only entries that passed the gate in this run can ever be added.
 *
 * One row, one board (issue #87). A board is unique by (ats, slug), and
 * this script never decides that two rows are one company:
 *   - Appends a survivor that collides with nothing, and one whose
 *     `company` is an existing company key (a human asserted the link in
 *     the candidates file).
 *   - Refuses a board (ats, slug) that is already registered, an entry
 *     missing slug, name or sector, and a Workday entry without the full
 *     config {tenant, env, site}. Refusals are printed.
 *   - Sets every other collision aside: a survivor whose normalized slug,
 *     name or company matches an existing row's slug, name or company in
 *     any file goes to tmp/registry-review.json and is printed. It is
 *     neither appended nor dropped. A reviewer applies it with
 *     scripts/link-registry.mjs.
 *   - Refuses reports generated from the live registry (would re-append
 *     existing entries); only --candidates reports are accepted.
 *
 * Rewrites each touched file with recomputed column alignment (key order
 * slug, name, sector, company, config) and preserves the file's line endings.
 *
 * Usage:
 *   node scripts/verify-registry.mjs --candidates tmp/candidates.json
 *   node scripts/append-registry.mjs
 *   node scripts/append-registry.mjs --report tmp/verify-report.json
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { loadRegistryFiles, writeRegistryFile, planAppend } from './registry-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_DIR = join(ROOT, 'registry');
const REVIEW_PATH = 'tmp/registry-review.json';

const reportPath = parseArgs({ options: { report: { type: 'string', default: 'tmp/verify-report.json' } } }).values.report;

async function main() {
  const report = JSON.parse(await readFile(join(ROOT, reportPath), 'utf-8'));
  if (report.generatedFrom === 'live-registry') {
    throw new Error('report was generated from the live registry, not a --candidates run; nothing to append');
  }

  const registry = await loadRegistryFiles(REGISTRY_DIR);
  const { added, refused, review } = planAppend(registry, report.survivorsByAts || {});

  for (const [ats, slugs] of Object.entries(added)) {
    await writeRegistryFile(REGISTRY_DIR, ats, registry[ats]);
    console.log(`  ${ats.padEnd(16)} +${slugs.length}: ${slugs.join(', ')}`);
  }
  if (refused.length) {
    console.log('\nRefused:');
    for (const s of refused) console.log(`  ${s}`);
  }

  if (review.length) {
    // The candidate's own gate result travels with it, so the reviewer
    // sees what the board said about itself.
    const gate = (item) => (report.survivors || []).find((s) => s.ats === item.ats && s.slug === item.candidate.slug);
    const items = review.map((item) => ({ ...item, candidate_gate: gate(item) ?? null }));
    await mkdir(join(ROOT, 'tmp'), { recursive: true });
    await writeFile(join(ROOT, REVIEW_PATH), JSON.stringify({ generatedFrom: reportPath, items }, null, 2) + '\n');
    console.log(`\nReview (${review.length}), set aside in ${REVIEW_PATH}, not appended:`);
    items.forEach((item, i) => {
      const hits = item.collisions.map((c) => `${c.ats}/${c.row.slug} "${c.row.name}" (${c.matched_on.join('+')})`).join('; ');
      console.log(`  [${i}] ${item.ats}/${item.candidate.slug} "${item.candidate.name}" collides with ${hits}`);
    });
    console.log(`Next: node scripts/verify-registry.mjs --recheck ${REVIEW_PATH}   (live-checks the existing rows and proposes a label)`);
    console.log('Then list every item in the PR under "Review". A maintainer applies one with scripts/link-registry.mjs.');
  }

  const total = Object.values(registry).reduce((n, { entries }) => n + entries.length, 0);
  const addedCount = Object.values(added).reduce((n, s) => n + s.length, 0);
  console.log(`\nAppended ${addedCount} entr${addedCount === 1 ? 'y' : 'ies'}. Registry total: ${total}.`);
  if (addedCount > 0) console.log('Next: npm run sync:registry-pages && node --test test/*.test.js');
}

main().catch((err) => {
  console.error('append-registry failed:', err.message);
  process.exit(1);
});
