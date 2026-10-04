import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AtsError } from './errors.js';
import { ADAPTERS, ATS_NAMES } from './adapters/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_DIR = join(__dirname, '..', 'registry');

// The one order the registry is ever walked in. Lookups, detectAts and the
// loaded object all follow it, so which file answers for a slug does not
// depend on which file's load finished first (issue #87).
const PLATFORMS = ATS_NAMES;

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
  const lists = await Promise.all(PLATFORMS.map(loadPlatform));
  return Object.fromEntries(PLATFORMS.map((platform, i) => [platform, lists[i]]));
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
 * Search registry for companies matching a query, best match first: an
 * exact name or slug, then a name that starts with the query, then a name
 * that contains it, then a sector-only match. Ties keep platform order, so
 * a caller that cuts the list drops the weakest matches (issue #62).
 */
export async function searchRegistry(query) {
  const all = await loadRegistry();
  const lower = query.toLowerCase();
  const results = [];

  for (const [ats, companies] of Object.entries(all)) {
    for (const company of companies) {
      const name = (company.name || company.slug || '').toLowerCase();
      const sector = (company.sector || '').toLowerCase();
      const rank = name === lower || String(company.slug).toLowerCase() === lower ? 0
        : name.startsWith(lower) ? 1
        : name.includes(lower) ? 2
        : sector.includes(lower) ? 3
        : -1;
      if (rank >= 0) results.push({ rank, row: { ...company, ats } });
    }
  }

  return results.sort((a, b) => a.rank - b.rank).map(r => r.row);
}

// Slug match is case/punctuation-insensitive: registry slugs are stored
// in each ATS's canonical form (SmartRecruiters uses PascalCase, e.g.
// "Visa"), but callers pass a lowercased/alnum-stripped slug. Comparing
// normalized forms keeps registry-first routing working for those.
export const normSlug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

const byPlatform = (a, b) => PLATFORMS.indexOf(a.ats) - PLATFORMS.indexOf(b.ats);

/**
 * Look up which ATS a slug belongs to in the registry.
 * Returns the ATS name (e.g., "greenhouse") or null if not in registry.
 */
export async function findAtsBySlug(slug) {
  const hit = await findEntryBySlug(slug);
  return hit ? hit.ats : null;
}

/**
 * Look up the full registry entry for a slug, with its ATS.
 * Unlike findAtsBySlug (returns just the ats name), this returns the
 * whole entry so callers can read adapter-specific config (e.g. the
 * Workday {tenant, env, site} triple). The files are searched in
 * PLATFORMS order, so the first match is the same on every call.
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
 * Where a company answers: the registry first, then a live probe of every
 * adapter the registry did not already answer for.
 *
 * A slug the registry knows is listed with source 'registry' and not probed
 * (Workday included, whose boards cannot be probed at all). Every remaining
 * adapter's has() then runs: true adds a board with source 'probe', false
 * adds nothing, and an AtsError (429, 5xx, 401, network) goes to `failed`
 * with its code, so a board the probe could not check never reads as
 * absent (issue #55). Any other error is a bug and is rethrown. Both lists
 * come back in PLATFORMS order, never in completion order.
 *
 * @returns {Promise<{
 *   boards: Array<{ ats: string, slug: string, source: 'registry'|'probe' }>,
 *   failed: Array<{ ats: string, slug: string, code: string, message: string }>,
 * }>}
 */
export async function detectAtsDetailed(companyName) {
  const slug = normSlug(companyName);
  const all = await loadRegistry();

  const boards = [];
  const failed = [];
  const known = new Set();
  for (const [ats, companies] of Object.entries(all)) {
    const entry = companies.find(c => normSlug(c.slug) === slug);
    if (entry) {
      boards.push({ ats, slug: entry.slug, source: 'registry' });
      known.add(ats);
    }
  }

  const probes = Object.entries(ADAPTERS).filter(([ats]) => !known.has(ats));
  const outcomes = await Promise.all(probes.map(async ([ats, adapter]) => {
    try {
      return { ats, found: await adapter.has(slug) };
    } catch (err) {
      if (!(err instanceof AtsError)) throw err;
      return { ats, error: err };
    }
  }));
  for (const { ats, found, error } of outcomes) {
    if (error) failed.push({ ats, slug, code: error.code, message: error.message });
    else if (found) boards.push({ ats, slug, source: 'probe' });
  }

  return { boards: boards.sort(byPlatform), failed: failed.sort(byPlatform) };
}

/**
 * Auto-detect which ATS a company uses: the boards from detectAtsDetailed
 * as [{ ats, slug }]. A failed probe never rejects this; the detailed
 * variant is where those are reported. An adapter throwing anything but an
 * AtsError is a bug and propagates, as it does through fetchJobs.
 */
export async function detectAts(companyName) {
  const { boards } = await detectAtsDetailed(companyName);
  return boards.map(({ ats, slug }) => ({ ats, slug }));
}
