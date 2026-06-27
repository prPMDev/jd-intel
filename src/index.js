/**
 * jd-intel — JD intelligence toolkit: fetch, normalize, and search job descriptions across every major ATS.
 *
 * Fetches, normalizes, and enriches job data from public ATS APIs
 * (Greenhouse, Lever, Ashby, SmartRecruiters, Teamtailor, Recruitee,
 * Workday) into a unified schema.
 */

import { ADAPTERS, ATS_NAMES } from './adapters/index.js';
import { loadRegistry, searchRegistry, detectAts, findAtsBySlug, findEntryBySlug, getRegistrySource } from './registry.js';
import { applyFilters } from './filters.js';

/**
 * Fetch jobs from a company's ATS board.
 *
 * @param {Object} options
 * @param {string} options.company - Company slug or name
 * @param {string} [options.ats] - Specific ATS platform. If omitted, auto-detects.
 * @param {object} [options.config] - Adapter-specific config (e.g. Workday {tenant, env, site}). Bypasses the registry; the only way to reach a Workday company not in the registry.
 * @param {string} [options.titleFilter] - Regex matched against title only. Use for role identity ("product manager", "staff engineer").
 * @param {string} [options.filter] - Regex matched across title, department, description. Use for topic/scope.
 * @param {number} [options.postedWithinDays] - Only return jobs posted within N days.
 * @param {string[]} [options.locationIncludes] - Keep jobs whose location contains any of these (case-insensitive).
 * @param {string[]} [options.locationExcludes] - Drop jobs whose location contains any of these (case-insensitive).
 * @param {number} [options.limit=100] - Maximum jobs to return after filtering.
 * @returns {Promise<Array>} Normalized, filtered job objects
 */
export async function fetchJobs({
  company,
  ats,
  config,
  titleFilter,
  filter,
  postedWithinDays,
  locationIncludes,
  locationExcludes,
  limit = 100,
} = {}) {
  if (!company) throw new Error('Company slug required');

  // Unified slug normalization: strip all non-alphanumeric (matches detectAts)
  const slug = company.toLowerCase().replace(/[^a-z0-9]/g, '');

  // Filter context is passed as an additive 2nd arg to adapters. Existing
  // adapters declare fetch{Name}(slug) and ignore extra positional args
  // (JS no-op), so this is backward-compatible. Filter-aware adapters
  // (e.g. Workday) use it to avoid mass detail-fetching on huge tenants.
  const filterContext = { titleFilter, filter, postedWithinDays, locationIncludes, locationExcludes, limit };

  let jobs;
  if (ats) {
    const adapter = ADAPTERS[ats];
    if (!adapter) throw new Error(`Unknown ATS: ${ats}. Supported: ${ATS_NAMES.join(', ')}`);
    // Explicit ATS: an explicitly passed config wins (the only path that
    // can reach a Workday company not in the registry). With no explicit
    // config, fall back to the registry so config-keyed adapters
    // (Workday) and canonically-cased registry slugs (SmartRecruiters
    // "Visa") also work on the explicit path, not just under auto-detect.
    let fetchSlug = slug;
    let cfg = config;
    let companyName;
    if (!cfg) {
      const hit = await findEntryBySlug(slug);
      if (hit && hit.ats === ats) {
        fetchSlug = hit.entry.slug;
        cfg = hit.entry.config;
        companyName = hit.entry.name;
      }
    }
    jobs = await adapter.fetch(fetchSlug, { config: cfg, companyName, filterContext });
  } else {
    // Consult registry first — if we know which ATS this company uses,
    // skip probing the others (saves API calls, clearer error semantics).
    // The registry entry carries the canonical slug (so the adapter is
    // called with the ATS's own casing, e.g. SmartRecruiters "Visa") and
    // any adapter-specific config (the Workday {tenant,env,site} triple).
    const hit = await findEntryBySlug(slug);
    if (hit) {
      jobs = await ADAPTERS[hit.ats].fetch(hit.entry.slug, {
        config: config || hit.entry.config,
        companyName: hit.entry.name,
        filterContext,
      });
    } else {
      // Discovery mode: company not in registry, probe all adapters.
      // (Registry-only adapters like Workday bail here via their guard.)
      const results = await Promise.allSettled(
        Object.entries(ADAPTERS).map(async ([name, adapter]) => adapter.fetch(slug, { filterContext }))
      );
      jobs = results
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value);
    }
  }

  return applyFilters(jobs, { titleFilter, filter, postedWithinDays, locationIncludes, locationExcludes, limit });
}

/**
 * Search for companies in the registry.
 */
export async function search({ keyword, location, ats } = {}) {
  // For now, search is registry-based. With SQLite store, this becomes a full-text search.
  if (!keyword) throw new Error('Keyword required');
  return searchRegistry(keyword);
}

/**
 * Detect which ATS platform a company uses (probes each adapter).
 */
export { detectAts } from './registry.js';

/**
 * Look up which ATS a slug belongs to in the registry (cached, no network).
 * Returns the ATS name (e.g. "greenhouse", "workday") or null if not in registry.
 */
export { findAtsBySlug } from './registry.js';

/**
 * Registry management.
 */
export const registry = {
  load: loadRegistry,
  search: searchRegistry,
  detect: detectAts,
  findAtsBySlug,
  findEntryBySlug,
  getSource: getRegistrySource,
};

// Re-export individual adapters for direct use
export { fetchGreenhouse } from './adapters/greenhouse.js';
export { fetchLever } from './adapters/lever.js';
export { fetchAshby } from './adapters/ashby.js';

// Re-export filter logic for reuse (e.g., by the MCP server)
export { applyFilters } from './filters.js';

// Re-export the list of supported ATS names (e.g. so the MCP layer can report
// the full set detectAts probes, instead of hardcoding a stale subset).
export { ATS_NAMES };

// Error taxonomy + typed error. Adapters throw AtsError with a stable .code
// (ats_unreachable / rate_limited) so the MCP layer maps failures without
// parsing messages. ERROR_CODES is the single source of truth for both.
export { ERROR_CODES, AtsError } from './errors.js';
