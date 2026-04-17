/**
 * Apply filters to a list of normalized jobs.
 *
 * Facts go here (deterministic field matches). Interpretations stay with the
 * caller — this module does substring matching on structured fields, nothing
 * semantic.
 */
export function applyFilters(jobs, options = {}) {
  const {
    titleFilter,
    filter,
    postedWithinDays,
    locationIncludes,
    locationExcludes,
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
    const needles = locationIncludes.map(s => s.toLowerCase());
    result = result.filter(j => {
      const loc = (j.location || '').toLowerCase();
      return needles.some(n => loc.includes(n));
    });
  }

  if (Array.isArray(locationExcludes) && locationExcludes.length > 0) {
    const needles = locationExcludes.map(s => s.toLowerCase());
    result = result.filter(j => {
      const loc = (j.location || '').toLowerCase();
      return !needles.some(n => loc.includes(n));
    });
  }

  if (typeof limit === 'number' && result.length > limit) {
    result = result.slice(0, limit);
  }

  return result;
}
