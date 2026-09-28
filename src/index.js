/**
 * jd-intel — JD intelligence toolkit: fetch, normalize, and search job descriptions across every major ATS.
 *
 * Fetches, normalizes, and enriches job data from public ATS APIs
 * (Greenhouse, Lever, Ashby, SmartRecruiters, Teamtailor, Recruitee,
 * Workday) into a unified schema.
 */

import { ADAPTERS, ATS_NAMES } from './adapters/index.js';
import { loadRegistry, searchRegistry, detectAts, detectAtsDetailed, findAtsBySlug, findEntryBySlug, getRegistrySource, normSlug } from './registry.js';
import { filterJobs, pageJobs, compileFilterPatterns } from './filters.js';
import { AtsError, ArgumentError, ERROR_CODES } from './errors.js';
import { describeBoard } from './boards.js';

// The counts an adapter reports about its scan. boards[].scan carries these
// and nothing else; org_name and org_url from the same report go on the
// board itself.
const SCAN_KEYS = ['listed', 'prefiltered', 'hydrated', 'capped'];

/**
 * Fetch jobs from a company's ATS board.
 *
 * Same options as fetchJobsDetailed; returns the page as an array.
 *
 * Discovery that found no board while at least one check failed throws an
 * AtsError (rate_limited when any failure was a 429, else ats_unreachable)
 * instead of returning []: an array has no place for `failed`, and an empty
 * one would read as "not found" (issue #55).
 *
 * @returns {Promise<Array>} Normalized, filtered job objects
 */
export async function fetchJobs(options = {}) {
  const result = await fetchJobsDetailed(options);
  if (result.match === 'probe' && result.boards.length === 0 && result.failed.length > 0) {
    throw discoveryFailure(options.company, result.failed);
  }
  return result.jobs;
}

/**
 * Fetch jobs from a company's ATS board, with the counts and the boards
 * behind the page.
 *
 * @param {Object} options
 * @param {string} options.company - Company slug or name
 * @param {string} [options.ats] - Specific ATS platform. If omitted, auto-detects.
 * @param {object} [options.config] - Adapter-specific config (e.g. Workday {tenant, env, site}). Bypasses the registry; the only way to reach a Workday company not in the registry.
 * @param {string} [options.titleFilter] - Regex matched against title only. Use for role identity ("product manager", "staff engineer").
 * @param {string} [options.filter] - Regex matched across title, department, description. Use for topic/scope.
 * @param {number} [options.postedWithinDays] - Only return jobs posted within N days.
 * @param {string[]} [options.locationIncludes] - Keep jobs where any listed location contains any of these (case-insensitive).
 * @param {string[]} [options.locationExcludes] - Drop jobs only when every listed location contains one of these (case-insensitive).
 * @param {'newest'|'board'} [options.order='newest'] - 'newest': by postedAt descending, undated last, ties by id. 'board': the adapter's own order.
 * @param {number} [options.offset=0] - Matches to skip after sorting (paging).
 * @param {number} [options.limit=100] - Maximum jobs to return after offset.
 * @returns {Promise<{
 *   jobs: Array,
 *   total_matched: number,
 *   total_before_filters: number,
 *   match: 'registry'|'probe'|'workday_override',
 *   company: { key: string, name: string }|null,
 *   boards: Array<object>,
 *   failed: Array<{ ats: string, slug: string, name: string|null, code: string, message: string }>,
 * }>}
 *   jobs: the page. total_matched: matches before offset and limit.
 *   total_before_filters: rows every board listed before any filter (on
 *   Workday and SmartRecruiters the list count, not the rows they hydrated).
 *   match: how the company was resolved. company: the registry row's name
 *   and its key (normalized name); null unless match is 'registry'.
 *   boards: one entry per board that answered (see src/boards.js), with
 *   jobs_found and matched counted per board, and org_name and org_url as
 *   the board states them (null where its ATS exposes nothing). failed:
 *   adapters that threw an AtsError during discovery; on a registry hit
 *   the error propagates.
 * @throws {ArgumentError} No company, unknown ats, or a filter regex that does not compile.
 * @throws {AtsError} The board's ATS failed on a registry hit, an explicit ats, or a Workday override.
 */
export async function fetchJobsDetailed({
  company,
  ats,
  config,
  titleFilter,
  filter,
  postedWithinDays,
  locationIncludes,
  locationExcludes,
  order = 'newest',
  offset = 0,
  limit = 100,
} = {}) {
  if (!company) throw new ArgumentError('company is required');
  compileFilterPatterns({ titleFilter, filter });

  const slug = normSlug(company);
  const filters = { titleFilter, filter, postedWithinDays, locationIncludes, locationExcludes };

  // Which boards to fetch, and how the company was resolved. A registry hit
  // and a Workday override are one board each and their errors propagate.
  // Discovery (not in the registry, no ats) asks every adapter, keeps the
  // ones that answered, and records the ones that failed.
  let match = 'probe';
  let discovery = false;
  let targets;

  if (ats) {
    if (!ADAPTERS[ats]) throw new ArgumentError(`Unknown ATS: ${ats}. Supported: ${ATS_NAMES.join(', ')}`);
    // Explicit ATS: an explicitly passed config wins (the only path that
    // can reach a Workday company not in the registry). With no explicit
    // config, the registry supplies the canonical slug, config and name
    // when it lists the company on that ATS (Workday's triple,
    // SmartRecruiters' PascalCase slugs).
    const hit = config ? null : await findEntryBySlug(slug);
    if (hit && hit.ats === ats) {
      match = 'registry';
      targets = [registryTarget(hit, config)];
    } else {
      if (ats === 'workday' && config) match = 'workday_override';
      targets = [{ ats, slug, name: null, config }];
    }
  } else {
    // Registry first: a known company costs one adapter call, with the
    // ATS's own slug casing and any adapter config the row carries.
    const hit = await findEntryBySlug(slug);
    if (hit) {
      match = 'registry';
      targets = [registryTarget(hit, config)];
    } else {
      discovery = true;
      targets = ATS_NAMES.map(atsName => ({ ats: atsName, slug, name: null, config: undefined }));
    }
  }

  // Adapters get the filters and the page so filter-aware ones (Workday,
  // SmartRecruiters) hydrate only what the page needs, plus `report`, which
  // records what an adapter chooses to say about its own board: the scan
  // counts, and the org name and host the board states. Every call for one
  // adapter merges into one record, so the two can arrive together or apart.
  const reports = {};
  const outcomes = await Promise.allSettled(targets.map(t =>
    ADAPTERS[t.ats].fetch(t.slug, {
      config: t.config,
      companyName: t.name ?? undefined,
      filterContext: { ...filters, offset, limit },
      report: (fields) => {
        reports[t.ats] = { ...reports[t.ats], ...fields };
      },
    })
  ));

  const boards = [];
  const failed = [];
  const rows = [];
  targets.forEach((t, i) => {
    const outcome = outcomes[i];
    if (outcome.status === 'rejected') {
      const err = outcome.reason;
      if (!discovery || !(err instanceof AtsError)) throw err;
      failed.push({ ats: t.ats, slug: t.slug, name: t.name, code: err.code, message: err.message });
      return;
    }
    // jobs_found is the board's list before any filter. Workday and
    // SmartRecruiters filter their list before hydrating and report what
    // they listed; counting their rows instead would make a filter miss on
    // a hiring company read as an empty board (issue #60). Every other
    // adapter returns its whole list.
    const report = reports[t.ats] ?? {};
    const scan = SCAN_KEYS.some(k => report[k] !== undefined)
      ? Object.fromEntries(SCAN_KEYS.map(k => [k, report[k]]))
      : null;
    const listed = scan?.listed ?? outcome.value.length;
    // A probed board exists when it listed rows: a 404 and an empty board
    // both come back as []. A registry hit or an override is a board
    // whatever it returned.
    if (match === 'probe' && listed === 0) return;
    rows.push(...outcome.value);
    boards.push(describeBoard({
      ...t,
      org_name: report.org_name ?? null,
      org_url: report.org_url ?? null,
      jobs_found: listed,
      scan,
    }));
  });

  const matched = filterJobs(rows, filters);
  const perBoard = new Map();
  for (const job of matched) {
    const key = `${job.ats}|${job.companySlug}`;
    perBoard.set(key, (perBoard.get(key) || 0) + 1);
  }
  for (const board of boards) board.matched = perBoard.get(`${board.ats}|${board.slug}`) || 0;

  return {
    jobs: pageJobs(matched, { order, offset, limit }),
    total_matched: matched.length,
    total_before_filters: boards.reduce((n, b) => n + b.jobs_found, 0),
    match,
    company: match === 'registry' ? { key: normSlug(targets[0].name), name: targets[0].name } : null,
    boards,
    failed,
  };
}

function registryTarget(hit, config) {
  return { ats: hit.ats, slug: hit.entry.slug, name: hit.entry.name, config: config || hit.entry.config };
}

function discoveryFailure(company, failed) {
  const limited = failed.some(f => f.code === ERROR_CODES.RATE_LIMITED);
  const checks = failed.map(f => `${f.ats} (${f.message})`).join('; ');
  return new AtsError(
    limited ? ERROR_CODES.RATE_LIMITED : ERROR_CODES.ATS_UNREACHABLE,
    `No board answered for "${company}" and the check failed on ${checks}`,
    limited ? 429 : undefined
  );
}

/**
 * Search for companies in the registry.
 */
export async function search({ keyword, location, ats } = {}) {
  // For now, search is registry-based. With SQLite store, this becomes a full-text search.
  if (!keyword) throw new ArgumentError('keyword is required');
  return searchRegistry(keyword);
}

/**
 * Detect which ATS platform a company uses: the registry first, then a
 * probe of each adapter. detectAts returns [{ ats, slug }]; detectAtsDetailed
 * adds each board's source and the probes that failed.
 */
export { detectAts, detectAtsDetailed } from './registry.js';

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
  detectDetailed: detectAtsDetailed,
  findAtsBySlug,
  findEntryBySlug,
  getSource: getRegistrySource,
};

// Re-export individual adapters for direct use
export { fetchGreenhouse } from './adapters/greenhouse.js';
export { fetchLever } from './adapters/lever.js';
export { fetchAshby } from './adapters/ashby.js';

// Re-export filter logic for reuse (e.g., by the MCP server)
export { applyFilters, applyFiltersDetailed } from './filters.js';

// Re-export the list of supported ATS names (e.g. so the MCP layer can report
// the full set detectAts probes, instead of hardcoding a stale subset).
export { ATS_NAMES };

// Error taxonomy + typed errors. Adapters throw AtsError with a stable .code
// (ats_unreachable / rate_limited); the library throws ArgumentError
// (invalid_args) for a call it cannot make. The MCP layer maps both by code
// without parsing messages. ERROR_CODES is the single source of truth.
export { ERROR_CODES, AtsError, ArgumentError } from './errors.js';

// HTTP settings for every adapter request: timeout, retries, per-host cap.
// For tests and scripts; the defaults are right for normal use.
export { configureHttp } from './http.js';
