import { normalize, toIso } from '../normalizer.js';
import { atsErrorFromStatus } from '../errors.js';
import { atsFetch, probeResult } from '../http.js';

const BASE_URL = 'https://apply.workable.com/api/v1/widget/accounts';

/**
 * Fetch jobs from a Workable careers page via its public widget endpoint.
 *
 * Why the widget, not the official API: Workable's REST API needs a
 * per-account token. The widget endpoint is the unauthenticated one the
 * hosted careers page itself calls, and `details=true` adds each job's
 * full HTML description, so one GET returns the whole board.
 *
 * An account with nothing open answers 200 with `jobs: []`; a slug with no
 * account answers 404.
 *
 * @param {string} slug - Workable account slug (e.g., 'epignosis')
 * @param {object} [ctx] - { report }; report is called once with
 *   { org_name, org_url } when given
 * @returns {Promise<Array>} Normalized job objects
 */
export async function fetchWorkable(slug, ctx = {}) {
  const resp = await atsFetch(`${BASE_URL}/${slug}?details=true`);

  if (!resp.ok) {
    if (resp.status === 404) return []; // No Workable account for this slug
    throw atsErrorFromStatus(resp.status, `Workable API error for ${slug}: ${resp.status}`);
  }

  const data = await resp.json();
  const jobs = data.jobs || [];

  // The account's own name is at the top of the response. Every link is on
  // apply.workable.com, so there is no company host to report.
  if (typeof ctx.report === 'function') {
    ctx.report({ org_name: data.name || null, org_url: null });
  }

  return jobs.map(job => {
    const place = [job.city, job.state, job.country].filter(Boolean).join(', ');
    return normalize({
      companySlug: slug,
      company: data.name || slug,
      title: job.title || '',
      department: job.department || '',
      location: job.telecommuting ? (place ? `Remote - ${place}` : 'Remote') : place,
      locations: (job.locations || [])
        .filter(l => !l.hidden)
        .map(l => [l.city, l.region, l.country].filter(Boolean).join(', ')),
      // `telecommuting` can only say remote; false means nothing.
      workplace: job.telecommuting === true ? 'remote' : null,
      description: job.description || '',
      url: job.url || job.shortlink || '',
      // Date-only strings ("2026-09-07").
      postedAt: toIso(job.published_on) || toIso(job.created_at),
      salary: null, // No structured salary; normalizer parses from text
      metadata: {
        workableId: job.shortcode,
        code: job.code || '',
        employmentType: job.employment_type || '',
        experience: job.experience || '',
        education: job.education || '',
        industry: job.industry || '',
        function: job.function || '',
      },
    }, 'workable');
  });
}

/**
 * Check if a company has a Workable account. See probeResult for the
 * outcomes. The plain list (no details) is the cheap request.
 */
export async function hasWorkable(slug) {
  const resp = await atsFetch(`${BASE_URL}/${slug}`);
  return probeResult(resp, `Workable probe for ${slug}`);
}
