/**
 * ats-index — A structured index of who's hiring what, across every major ATS.
 *
 * Fetches, normalizes, and enriches job data from public ATS APIs
 * (Greenhouse, Lever, Ashby) into a unified schema.
 */

import { ADAPTERS, ATS_NAMES } from './adapters/index.js';
import { loadRegistry, searchRegistry, detectAts } from './registry.js';
import { applyFilters } from './filters.js';

/**
 * Fetch jobs from a company's ATS board.
 *
 * @param {Object} options
 * @param {string} options.company - Company slug or name
 * @param {string} [options.ats] - Specific ATS platform. If omitted, auto-detects.
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
  titleFilter,
  filter,
  postedWithinDays,
  locationIncludes,
  locationExcludes,
  limit = 100,
} = {}) {
  if (!company) throw new Error('Company slug required');

  const slug = company.toLowerCase().replace(/\s+/g, '');

  let jobs;
  if (ats) {
    const adapter = ADAPTERS[ats];
    if (!adapter) throw new Error(`Unknown ATS: ${ats}. Supported: ${ATS_NAMES.join(', ')}`);
    jobs = await adapter.fetch(slug);
  } else {
    const results = await Promise.allSettled(
      Object.entries(ADAPTERS).map(async ([name, adapter]) => adapter.fetch(slug))
    );
    jobs = results
      .filter(r => r.status === 'fulfilled')
      .flatMap(r => r.value);
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
 * Detect which ATS platform a company uses.
 */
export { detectAts } from './registry.js';

/**
 * Registry management.
 */
export const registry = {
  load: loadRegistry,
  search: searchRegistry,
  detect: detectAts,
};

// Re-export individual adapters for direct use
export { fetchGreenhouse } from './adapters/greenhouse.js';
export { fetchLever } from './adapters/lever.js';
export { fetchAshby } from './adapters/ashby.js';

// Re-export filter logic for reuse (e.g., by the MCP server)
export { applyFilters } from './filters.js';
