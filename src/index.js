/**
 * ats-index — A structured index of who's hiring what, across every major ATS.
 *
 * Fetches, normalizes, and enriches job data from public ATS APIs
 * (Greenhouse, Lever, Ashby) into a unified schema.
 */

import { ADAPTERS, ATS_NAMES } from './adapters/index.js';
import { loadRegistry, searchRegistry, detectAts } from './registry.js';

/**
 * Fetch jobs from a company's ATS board.
 *
 * @param {Object} options
 * @param {string} options.company - Company slug or name
 * @param {string} [options.ats] - Specific ATS platform. If omitted, auto-detects.
 * @returns {Promise<Array>} Normalized job objects
 */
export async function fetchJobs({ company, ats }) {
  if (!company) throw new Error('Company slug required');

  const slug = company.toLowerCase().replace(/\s+/g, '');

  if (ats) {
    const adapter = ADAPTERS[ats];
    if (!adapter) throw new Error(`Unknown ATS: ${ats}. Supported: ${ATS_NAMES.join(', ')}`);
    return adapter.fetch(slug);
  }

  // Auto-detect: try all ATS platforms in parallel
  const results = await Promise.allSettled(
    Object.entries(ADAPTERS).map(async ([name, adapter]) => {
      const jobs = await adapter.fetch(slug);
      return jobs;
    })
  );

  return results
    .filter(r => r.status === 'fulfilled')
    .flatMap(r => r.value);
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
