import { normalize, extractSalaryFromText } from '../normalizer.js';
import { atsErrorFromStatus } from '../errors.js';
import { atsFetch, probeResult } from '../http.js';

const BOARD_URL = 'https://api.ashbyhq.com/posting-api/job-board';

/**
 * Fetch all jobs from an Ashby job board.
 * Public API, no auth required.
 * Docs: https://developers.ashbyhq.com/docs/public-job-posting-api
 *
 * REST only. The GraphQL fallback this adapter once carried never named a
 * board, so it never returned a job, and it turned every REST 429 or 5xx
 * into a silent empty result (issue #55).
 *
 * @param {string} slug - Company slug (e.g., 'notion', 'linear')
 * @param {object} [ctx] - { report }; report is called once with
 *   { ats, org_name, org_url } when given
 * @returns {Promise<Array>} Normalized job objects
 */
export async function fetchAshby(slug, ctx = {}) {
  const url = `${BOARD_URL}/${slug}?includeCompensation=true`;
  const resp = await atsFetch(url);

  if (!resp.ok) {
    if (resp.status === 404) return [];
    throw atsErrorFromStatus(resp.status, `Ashby REST API error for ${slug}: ${resp.status}`);
  }

  const data = await resp.json();
  const jobs = data.jobs || [];

  // The REST response is { jobs, apiVersion }: no organization name, and
  // every link is on jobs.ashbyhq.com. Both null (issue #58).
  if (typeof ctx.report === 'function') {
    ctx.report({ ats: 'ashby', org_name: null, org_url: null });
  }

  return jobs.map(job => {
    const comp = job.compensation || {};

    return normalize({
      companySlug: slug,
      company: data.organizationName || slug,
      title: job.title || '',
      department: job.department || '',
      location: job.location || '',
      locations: (job.secondaryLocations || []).map(l => l?.location || ''),
      workplace: parseAshbyWorkplace(job),
      description: job.descriptionHtml || job.descriptionPlain || '',
      url: `https://jobs.ashbyhq.com/${slug}/${job.id}`,
      postedAt: job.publishedAt || null,
      salary: parseAshbyCompensation(comp),
      metadata: {
        ashbyId: job.id,
        employmentType: job.employmentType || '',
        isRemote: job.isRemote || false,
        team: job.team || '',
        // The rendered summaries keep what min/max drop: "Offers Equity",
        // "Multiple Ranges", and per-location tiers labelled OTE.
        compensationSummary: comp.compensationTierSummary || '',
        compensationTiers: (comp.compensationTiers || []).map(tier => ({
          title: tier.title || '',
          summary: tier.tierSummary || '',
          additionalInformation: tier.additionalInformation || '',
        })),
      },
    }, 'ashby');
  });
}

const WORKPLACE_TYPES = { remote: 'remote', hybrid: 'hybrid', onsite: 'onsite' };

/**
 * `workplaceType` is 'Remote', 'Hybrid' or 'OnSite'. `isRemote` is the
 * older flag and can only say remote, so it is the fallback when the type
 * is absent. false means nothing: the role may be hybrid or onsite.
 */
function parseAshbyWorkplace(job) {
  const type = WORKPLACE_TYPES[String(job.workplaceType || '').toLowerCase()];
  if (type) return type;
  return job.isRemote === true ? 'remote' : null;
}

const INTERVAL_PERIOD = { '1 YEAR': 'year', '1 MONTH': 'month', '1 HOUR': 'hour' };

/**
 * Read pay from Ashby's `compensation` object (issue #67).
 *
 * `summaryComponents` carries one structured entry per component type
 * (Salary, Bonus, Commission, Equity); the Salary entry spans every tier.
 * `scrapeableCompensationSalarySummary` and `compensationTierSummary` are
 * the rendered strings. A board that publishes no pay still sends the
 * object, with null summaries and empty arrays, so a miss here has to
 * return null for the normalizer's text fallback to run.
 */
function parseAshbyCompensation(comp) {
  const salary = (comp.summaryComponents || []).find(c => c.compensationType === 'Salary');
  if (salary && (salary.minValue != null || salary.maxValue != null)) {
    return {
      min: salary.minValue ?? null,
      max: salary.maxValue ?? null,
      currency: salary.currencyCode || 'USD',
      period: INTERVAL_PERIOD[salary.interval] || null,
      source: 'ats',
    };
  }
  // The summaries are still the ATS's own compensation field, so a range
  // read out of one counts as source 'ats'.
  const parsed = extractSalaryFromText(comp.scrapeableCompensationSalarySummary)
    || extractSalaryFromText(comp.compensationTierSummary);
  return parsed ? { ...parsed, source: 'ats' } : null;
}

/**
 * Check if a company has an Ashby board. See probeResult for the outcomes.
 */
export async function hasAshby(slug) {
  const resp = await atsFetch(`${BOARD_URL}/${slug}`, { method: 'HEAD' });
  return probeResult(resp, `Ashby probe for ${slug}`);
}
