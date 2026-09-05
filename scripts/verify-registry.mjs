#!/usr/bin/env node
/**
 * Registry verifier — dogfoods the real fetchJobs path to confirm each
 * registry entry still returns jobs from its ATS.
 *
 * The project rule is: every registry entry is live-verified against the
 * ATS API before it is added (and stays fetchable after). This script
 * operationalizes that rule for two jobs:
 *   1. Gating a seed: `--candidates <file>` verifies staged entries that
 *      are NOT yet in the registry (Workday needs its config passed
 *      explicitly, since registry lookup can't find it yet).
 *   2. Freshness check: with no args it verifies the live registry, so a
 *      future run catches companies that stopped hiring or moved tenants.
 *
 * It calls the adapter directly with the canonical slug — the same call
 * fetchJobs makes AFTER a registry lookup — so a pass means the entry
 * works end to end through normalize(), not just that a raw endpoint is
 * up. A small limit keeps huge tenants (e.g. CVS ~16k) cheap; we only
 * need jobCount > 0.
 *
 * Usage:
 *   node scripts/verify-registry.mjs                 # verify live registry
 *   node scripts/verify-registry.mjs --candidates tmp/candidates.json
 *   node scripts/verify-registry.mjs --concurrency 4 --limit 1
 *
 * Candidates file shape: { "<ats>": [ {slug, name, sector, config?}, ... ], ... }
 * Report written to tmp/verify-report.json.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ADAPTERS } from '../src/adapters/index.js';
import { loadRegistry } from '../src/registry.js';
import { ERROR_CODES } from '../src/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

function getArg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const candidatesPath = getArg('--candidates', null);
const CONCURRENCY = Number(getArg('--concurrency', '4'));
const LIMIT = Number(getArg('--limit', '1')); // jobCount>0 is the only signal we need

async function loadEntries() {
  if (candidatesPath) {
    const raw = await readFile(join(ROOT, candidatesPath), 'utf-8');
    return JSON.parse(raw);
  }
  return loadRegistry(); // { ats: [entries] }
}

// Transient-failure detector. ATS APIs rate-limit under load (Workday and
// SmartRecruiters both do at modest volume), and a 429 says nothing about
// whether a board is real. Treating one as a failure produced a 27% false
// drop rate on a 118-entry run, so these retry with backoff instead.
//
// The decision is structural, never a message regex: Workday error messages
// embed the pod name next to the status ("(ufp/wd503/Careers): 404"), so a
// /5\d\d/ match on the text reads that terminal 404 as a retryable 5xx.
const RETRIES = Number(getArg('--retries', '3'));
const NETWORK_ERR = /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up/i;

function isTransient(err) {
  if (err?.code === ERROR_CODES.RATE_LIMITED) return true;      // 429
  if (typeof err?.status === 'number') return err.status >= 500; // 5xx retry, 4xx terminal
  return NETWORK_ERR.test(err?.message || '');                   // DNS/socket, not an AtsError
}

async function verifyOne(ats, entry, attempt = 0) {
  // Call the adapter directly with the CANONICAL slug — exactly what
  // fetchJobs does AFTER a registry lookup (it passes hit.entry.slug).
  // We deliberately do NOT route through fetchJobs({company}) here: that
  // normalizes raw input (lowercase + strip non-alphanumeric), which
  // corrupts slugs carrying hyphens, dots, or meaningful casing (e.g.
  // "shopback-2", "AIFund", "metaprise.ai", "BoschGroup") for entries not
  // yet in the registry. The registry restores the canonical slug at
  // lookup time, so the adapter-direct call is the truthful test of
  // whether an entry will work once added.
  const adapter = ADAPTERS[ats];
  if (!adapter) {
    return { ats, slug: entry.slug, name: entry.name, status: 'error', jobCount: 0, error: `unknown ats: ${ats}` };
  }
  try {
    const jobs = await adapter.fetch(entry.slug, {
      config: entry.config,
      companyName: entry.name,
      filterContext: { limit: LIMIT },
    });
    const jobCount = Array.isArray(jobs) ? jobs.length : 0;
    return { ats, slug: entry.slug, name: entry.name, status: jobCount > 0 ? 'ok' : 'empty', jobCount };
  } catch (err) {
    if (attempt < RETRIES && isTransient(err)) {
      // Exponential backoff with jitter: 2s, 4s, 8s.
      const wait = 2000 * 2 ** attempt + Math.floor(Math.random() * 500);
      await new Promise((r) => setTimeout(r, wait));
      return verifyOne(ats, entry, attempt + 1);
    }
    return { ats, slug: entry.slug, name: entry.name, status: 'error', jobCount: 0, error: err.message };
  }
}

// Bounded-concurrency runner — polite to the ATS APIs.
async function runPool(tasks, concurrency) {
  const results = [];
  let i = 0;
  const workers = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (i < tasks.length) {
      const idx = i++;
      results[idx] = await tasks[idx]();
      await new Promise((r) => setTimeout(r, 150)); // small spacing
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const byAts = await loadEntries();
  const flat = [];
  for (const [ats, entries] of Object.entries(byAts)) {
    for (const entry of entries || []) flat.push({ ats, entry });
  }

  console.log(`Verifying ${flat.length} entries (concurrency=${CONCURRENCY}, limit=${LIMIT})${candidatesPath ? ` from ${candidatesPath}` : ' from live registry'}...\n`);

  const results = await runPool(
    flat.map(({ ats, entry }) => () => verifyOne(ats, entry)),
    CONCURRENCY
  );

  const survivors = results.filter((r) => r.status === 'ok');
  const dropped = results.filter((r) => r.status !== 'ok');

  // Per-ATS summary
  const perAts = {};
  for (const r of results) {
    perAts[r.ats] = perAts[r.ats] || { ok: 0, empty: 0, error: 0 };
    perAts[r.ats][r.status] += 1;
  }
  for (const [ats, c] of Object.entries(perAts)) {
    console.log(`  ${ats.padEnd(16)} ok=${c.ok}  empty=${c.empty}  error=${c.error}`);
  }
  console.log(`\nTotal: ${survivors.length} ok, ${dropped.length} dropped (empty/error).`);

  if (dropped.length) {
    console.log('\nDropped:');
    for (const d of dropped) {
      console.log(`  ${d.ats}/${d.slug} -> ${d.status}${d.error ? ` (${d.error})` : ''}`);
    }
  }

  // Survivors grouped back by ATS, carrying the original entry (incl. config),
  // so a seed step can append exactly what passed.
  const survivorsByAts = {};
  for (const { ats, entry } of flat) {
    if (survivors.some((s) => s.ats === ats && s.slug === entry.slug)) {
      (survivorsByAts[ats] = survivorsByAts[ats] || []).push(entry);
    }
  }

  await mkdir(join(ROOT, 'tmp'), { recursive: true });
  await writeFile(
    join(ROOT, 'tmp', 'verify-report.json'),
    JSON.stringify({ generatedFrom: candidatesPath || 'live-registry', perAts, survivors, dropped, survivorsByAts }, null, 2)
  );
  console.log('\nReport written to tmp/verify-report.json');
}

main().catch((err) => {
  console.error('verify-registry failed:', err);
  process.exit(1);
});
