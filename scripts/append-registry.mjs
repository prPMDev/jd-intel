#!/usr/bin/env node
/**
 * Registry appender — writes the survivors of a verify-registry.mjs
 * --candidates run into registry/*.json.
 *
 * Pairs with verify-registry.mjs: that script gates (live API check),
 * this one appends. It reads survivorsByAts from the verify report, so
 * only entries that passed the gate in this run can ever be added.
 *
 * Safety nets:
 *   - Refuses reports generated from the live registry (would re-append
 *     existing entries); only --candidates reports are accepted.
 *   - Drops any survivor whose normalized slug or name already exists in
 *     ANY registry file (same normalization findAtsBySlug uses), so a
 *     company never appears under two ATS.
 *   - Drops entries missing slug, name, or sector; Workday entries also
 *     need the full config {tenant, env, site} (adapter guard mirrors this).
 *
 * Rewrites each touched file with recomputed column alignment (key order
 * slug, name, sector, config) and preserves the file's line endings.
 *
 * Usage:
 *   node scripts/verify-registry.mjs --candidates tmp/candidates.json
 *   node scripts/append-registry.mjs
 *   node scripts/append-registry.mjs --report tmp/verify-report.json
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const REGISTRY_DIR = join(ROOT, 'registry');

function getArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const reportPath = getArg('--report', 'tmp/verify-report.json');

// Same normalization as findAtsBySlug in src/registry.js.
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

function formatEntry(e) {
  const fields = {
    slug: `"slug": ${JSON.stringify(e.slug)},`,
    name: `"name": ${JSON.stringify(e.name)},`,
    sector: `"sector": ${JSON.stringify(e.sector)}`,
  };
  if (e.config) {
    const { tenant, env, site } = e.config;
    fields.config = `"config": {"tenant": ${JSON.stringify(tenant)}, "env": ${JSON.stringify(env)}, "site": ${JSON.stringify(site)}}`;
  }
  return fields;
}

// One entry per line, slug and name fields padded so the following field
// aligns across the whole file (longest field + 1 space), sector unpadded.
function serialize(entries, eol) {
  const rows = entries.map(formatEntry);
  const slugW = Math.max(...rows.map((r) => r.slug.length)) + 1;
  const nameW = Math.max(...rows.map((r) => r.name.length)) + 1;
  const lines = rows.map((r) => {
    let line = `  {${r.slug.padEnd(slugW)}${r.name.padEnd(nameW)}${r.sector}`;
    if (r.config) line += `, ${r.config}`;
    return line + '}';
  });
  return `[${eol}${lines.join(`,${eol}`)}${eol}]${eol}`;
}

async function main() {
  const report = JSON.parse(await readFile(join(ROOT, reportPath), 'utf-8'));
  if (report.generatedFrom === 'live-registry') {
    throw new Error('report was generated from the live registry, not a --candidates run; nothing to append');
  }
  const survivorsByAts = report.survivorsByAts || {};

  const files = (await readdir(REGISTRY_DIR)).filter((f) => f.endsWith('.json'));
  const registry = {}; // ats -> { entries, eol }
  const seen = new Set(); // normalized slugs and names across ALL files
  for (const f of files) {
    const raw = await readFile(join(REGISTRY_DIR, f), 'utf-8');
    const ats = f.replace(/\.json$/, '');
    registry[ats] = { entries: JSON.parse(raw), eol: raw.includes('\r\n') ? '\r\n' : '\n' };
    for (const e of registry[ats].entries) {
      seen.add(norm(e.slug));
      seen.add(norm(e.name));
    }
  }

  const added = {};
  const skipped = [];
  for (const [ats, entries] of Object.entries(survivorsByAts)) {
    if (!registry[ats]) {
      skipped.push(...(entries || []).map((e) => `${ats}/${e.slug} -> no registry/${ats}.json`));
      continue;
    }
    for (const e of entries || []) {
      if (!e.slug || !e.name || !e.sector) {
        skipped.push(`${ats}/${e.slug || '?'} -> missing slug, name, or sector`);
        continue;
      }
      if (ats === 'workday' && !(e.config && e.config.tenant && e.config.env && e.config.site)) {
        skipped.push(`${ats}/${e.slug} -> workday entry missing config {tenant, env, site}`);
        continue;
      }
      if (seen.has(norm(e.slug)) || seen.has(norm(e.name))) {
        skipped.push(`${ats}/${e.slug} -> already in a registry file (slug or name match)`);
        continue;
      }
      seen.add(norm(e.slug));
      seen.add(norm(e.name));
      registry[ats].entries.push({ slug: e.slug, name: e.name, sector: e.sector, ...(e.config ? { config: e.config } : {}) });
      (added[ats] = added[ats] || []).push(e.slug);
    }
  }

  for (const [ats, slugs] of Object.entries(added)) {
    const { entries, eol } = registry[ats];
    await writeFile(join(REGISTRY_DIR, `${ats}.json`), serialize(entries, eol));
    console.log(`  ${ats.padEnd(16)} +${slugs.length}: ${slugs.join(', ')}`);
  }
  if (skipped.length) {
    console.log('\nSkipped:');
    for (const s of skipped) console.log(`  ${s}`);
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
