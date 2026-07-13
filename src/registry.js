import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_DIR = join(__dirname, '..', 'registry');

const PLATFORMS = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'teamtailor', 'recruitee', 'workday'];

// Network-first registry. A hosted copy lets installed bundles AND npx users
// pick up newly-added companies without reinstalling; the on-disk copy that
// ships with the package is the guaranteed offline fallback. The base URL is
// resolved at call time so it stays overridable: point JD_INTEL_REGISTRY_URL
// at a different host, or set it to '' to force disk-only (tests, air-gapped).
const DEFAULT_REGISTRY_URL = 'https://prpmdev.github.io/jd-intel/registry';
const FETCH_TIMEOUT_MS = 2500;

function registryBaseUrl() {
  return process.env.JD_INTEL_REGISTRY_URL !== undefined
    ? process.env.JD_INTEL_REGISTRY_URL
    : DEFAULT_REGISTRY_URL;
}

let cache = {};
let sources = {}; // platform -> 'network' | 'disk-fallback'

async function fetchPlatform(platform) {
  const base = registryBaseUrl();
  if (!base) throw new Error('registry network disabled');
  const res = await fetch(`${base}/${platform}.json`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`registry fetch ${platform}: HTTP ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error(`registry fetch ${platform}: not an array`);
  return data;
}

async function readPlatform(platform) {
  // Resolved at call time like registryBaseUrl(): JD_INTEL_REGISTRY_DIR
  // points the disk loader at a different directory (test fixtures), so
  // tests can assert lookup semantics without depending on live registry
  // content.
  const dir = process.env.JD_INTEL_REGISTRY_DIR || REGISTRY_DIR;
  const data = await readFile(join(dir, `${platform}.json`), 'utf-8');
  return JSON.parse(data);
}

// Load one platform: hosted copy first, on-disk fallback on ANY failure
// (offline, non-200, timeout, malformed). Cached per process after first load.
async function loadPlatform(platform) {
  if (cache[platform]) return cache[platform];
  try {
    cache[platform] = await fetchPlatform(platform);
    sources[platform] = 'network';
  } catch {
    try {
      cache[platform] = await readPlatform(platform);
    } catch {
      cache[platform] = [];
    }
    sources[platform] = 'disk-fallback';
  }
  return cache[platform];
}

/**
 * Load company registry for a specific ATS or all ATS platforms.
 * Network-first with on-disk fallback (see registryBaseUrl).
 */
export async function loadRegistry(ats) {
  if (ats) return loadPlatform(ats);
  const all = {};
  await Promise.all(PLATFORMS.map(async (platform) => {
    all[platform] = await loadPlatform(platform);
  }));
  return all;
}

/**
 * Where the registry data loaded this process came from:
 *   'network'       every loaded platform came from the hosted copy
 *   'disk-fallback' every loaded platform fell back to the bundled copy
 *   'mixed'         some of each
 *   'unknown'       nothing loaded yet
 * Surfaced in MCP response metadata so the AI can tell the user whether the
 * company list is live or the bundled snapshot.
 */
export function getRegistrySource() {
  const vals = Object.values(sources);
  if (vals.length === 0) return 'unknown';
  if (vals.every((v) => v === 'network')) return 'network';
  if (vals.every((v) => v === 'disk-fallback')) return 'disk-fallback';
  return 'mixed';
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

// Slug match is case/punctuation-insensitive: registry slugs are stored
// in each ATS's canonical form (SmartRecruiters uses PascalCase, e.g.
// "Visa"), but callers pass a lowercased/alnum-stripped slug. Comparing
// normalized forms keeps registry-first routing working for those.
const normSlug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

/**
 * Look up which ATS a slug belongs to in the registry.
 * Returns the ATS name (e.g., "greenhouse") or null if not in registry.
 */
export async function findAtsBySlug(slug) {
  const all = await loadRegistry();
  const key = normSlug(slug);
  for (const [ats, companies] of Object.entries(all)) {
    if (companies.some(c => normSlug(c.slug) === key)) return ats;
  }
  return null;
}

/**
 * Look up the full registry entry for a slug, with its ATS.
 * Unlike findAtsBySlug (returns just the ats name), this returns the
 * whole entry so callers can read adapter-specific config (e.g. the
 * Workday {tenant, env, site} triple). Additive — does not change
 * findAtsBySlug, which has other callers.
 *
 * @returns {Promise<{ats: string, entry: object}|null>}
 */
export async function findEntryBySlug(slug) {
  const all = await loadRegistry();
  const key = normSlug(slug);
  for (const [ats, companies] of Object.entries(all)) {
    const entry = companies.find(c => normSlug(c.slug) === key);
    if (entry) return { ats, entry };
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
