import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_DIR = join(__dirname, '..', 'registry');

let cache = {};

/**
 * Load company registry for a specific ATS or all ATS platforms.
 */
export async function loadRegistry(ats) {
  if (ats && cache[ats]) return cache[ats];

  if (ats) {
    try {
      const data = await readFile(join(REGISTRY_DIR, `${ats}.json`), 'utf-8');
      cache[ats] = JSON.parse(data);
      return cache[ats];
    } catch {
      return [];
    }
  }

  // Load all
  const all = {};
  for (const platform of ['greenhouse', 'lever', 'ashby']) {
    try {
      const data = await readFile(join(REGISTRY_DIR, `${platform}.json`), 'utf-8');
      all[platform] = JSON.parse(data);
      cache[platform] = all[platform];
    } catch {
      all[platform] = [];
    }
  }
  return all;
}

/**
 * Search registry for companies matching a query.
 */
export async function searchRegistry(query) {
  const all = await loadRegistry();
  const lower = query.toLowerCase();
  const results = [];

  for (const [ats, companies] of Object.entries(all)) {
    for (const company of companies) {
      const name = (company.name || company.slug || '').toLowerCase();
      const sector = (company.sector || '').toLowerCase();
      if (name.includes(lower) || sector.includes(lower)) {
        results.push({ ...company, ats });
      }
    }
  }

  return results;
}

/**
 * Look up which ATS a slug belongs to in the registry.
 * Returns the ATS name (e.g., "greenhouse") or null if not in registry.
 */
export async function findAtsBySlug(slug) {
  const all = await loadRegistry();
  for (const [ats, companies] of Object.entries(all)) {
    if (companies.some(c => c.slug === slug)) return ats;
  }
  return null;
}

/**
 * Auto-detect which ATS a company uses.
 */
export async function detectAts(companyName) {
  const { ADAPTERS } = await import('./adapters/index.js');
  const slug = companyName.toLowerCase().replace(/[^a-z0-9]/g, '');

  const results = [];
  const checks = Object.entries(ADAPTERS).map(async ([ats, adapter]) => {
    const found = await adapter.has(slug);
    if (found) results.push({ ats, slug });
  });

  await Promise.allSettled(checks);
  return results;
}
