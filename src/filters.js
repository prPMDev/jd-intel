/**
 * Apply filters to a list of normalized jobs.
 *
 * Facts go here (deterministic field matches). Interpretations stay with the
 * caller — this module does substring matching on structured fields, nothing
 * semantic.
 *
 * Returns the page as an array. applyFiltersDetailed returns the same page
 * plus total_matched, the match count before offset and limit.
 */
export function applyFilters(jobs, options = {}) {
  return applyFiltersDetailed(jobs, options).jobs;
}

/**
 * Filter, sort, then page.
 *
 * Order is applied after the filters and before offset and limit, so a cut
 * drops the oldest matches first. 'newest' sorts by postedAt descending with
 * undated jobs last and ties broken by id, which keeps pages deterministic.
 * 'board' keeps the order the adapter returned.
 *
 * @returns {{ jobs: Array, total_matched: number }}
 */
export function applyFiltersDetailed(jobs, options = {}) {
  const {
    titleFilter,
    filter,
    postedWithinDays,
    locationIncludes,
    locationExcludes,
    order = 'newest',
    offset = 0,
    limit = 100,
  } = options;

  let result = jobs;

  if (titleFilter) {
    const pattern = new RegExp(titleFilter, 'i');
    result = result.filter(j => pattern.test(j.title || ''));
  }

  if (filter) {
    const pattern = new RegExp(filter, 'i');
    result = result.filter(j =>
      pattern.test(j.title || '') ||
      pattern.test(j.department || '') ||
      pattern.test(j.description || '')
    );
  }

  if (typeof postedWithinDays === 'number') {
    const cutoff = Date.now() - postedWithinDays * 86400000;
    result = result.filter(j => {
      if (!j.postedAt) return false;
      const posted = new Date(j.postedAt).getTime();
      return Number.isFinite(posted) && posted >= cutoff;
    });
  }

  if (Array.isArray(locationIncludes) && locationIncludes.length > 0) {
    const matchers = locationIncludes.map(makeLocationMatcher);
    result = result.filter(j => jobLocations(j).some(loc => matchers.some(m => m(loc))));
  }

  if (Array.isArray(locationExcludes) && locationExcludes.length > 0) {
    const matchers = locationExcludes.map(makeLocationMatcher);
    result = result.filter(j => !jobLocations(j).every(loc => matchers.some(m => m(loc))));
  }

  const total_matched = result.length;

  if (order !== 'board') {
    result = [...result].sort(byNewest);
  }

  const start = typeof offset === 'number' && offset > 0 ? offset : 0;
  const end = typeof limit === 'number' ? start + limit : undefined;
  if (start > 0 || (end !== undefined && result.length > end)) {
    result = result.slice(start, end);
  }

  return { jobs: result, total_matched };
}

/**
 * Every location a job is open in, lowercased. A job passes an include when
 * any of them matches and is dropped by an exclude only when all of them
 * match: a role open in Berlin and New York is still open in Berlin for
 * someone excluding the US (issue #68). Jobs from before `locations`
 * existed fall back to the single `location` string.
 */
function jobLocations(job) {
  const list = Array.isArray(job.locations) && job.locations.length > 0
    ? job.locations
    : [job.location || ''];
  return list.map(loc => String(loc).toLowerCase());
}

function postedTime(job) {
  if (!job.postedAt) return null;
  const t = new Date(job.postedAt).getTime();
  return Number.isFinite(t) ? t : null;
}

function byNewest(a, b) {
  const ta = postedTime(a);
  const tb = postedTime(b);
  if (ta !== tb) {
    if (ta === null) return 1;
    if (tb === null) return -1;
    return tb - ta;
  }
  const ia = a.id || '';
  const ib = b.id || '';
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

/**
 * Build a matcher for a single location keyword. The matcher takes a
 * lowercased location string.
 *
 * Short tokens (≤4 chars) use word-boundary matching to prevent substring
 * collisions like "US" matching "Australia", "Brussels", "Belarus", or "UK"
 * matching "Ukraine". Longer tokens use substring matching so phrases like
 * "United States" can match "United States of America".
 *
 * Exported for the Workday list pre-filter, so one rule (trim, empty
 * keywords never match, word boundaries for short tokens) applies before
 * and after detail hydration (issue #61).
 */
export function makeLocationMatcher(needle) {
  const lower = (needle || '').toLowerCase().trim();
  if (!lower) return () => false;
  if (lower.length <= 4) {
    const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\b`);
    return (loc) => pattern.test(loc);
  }
  return (loc) => loc.includes(lower);
}
