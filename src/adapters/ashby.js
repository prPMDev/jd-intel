import { normalize, extractSalaryFromText } from '../normalizer.js';
import { atsErrorFromStatus } from '../errors.js';

const API_URL = 'https://jobs.ashbyhq.com/api/non-user-graphql';
const BOARD_URL = 'https://api.ashbyhq.com/posting-api/job-board';

/**
 * Fetch all jobs from an Ashby job board.
 * Public API, no auth required.
 * Docs: https://developers.ashbyhq.com/docs/public-job-posting-api
 *
 * @param {string} slug - Company slug (e.g., 'notion', 'linear')
 * @returns {Promise<Array>} Normalized job objects
 */
export async function fetchAshby(slug) {
  // Try the REST API first (simpler, includes compensation)
  try {
    const restJobs = await fetchAshbyRest(slug);
    if (restJobs.length > 0) return restJobs;
  } catch { /* fall through to GraphQL */ }

  // Fallback: GraphQL API
  return fetchAshbyGraphQL(slug);
}

async function fetchAshbyRest(slug) {
  const url = `${BOARD_URL}/${slug}?includeCompensation=true`;
  const resp = await fetch(url);

  if (!resp.ok) {
    if (resp.status === 404) return [];
    throw atsErrorFromStatus(resp.status, `Ashby REST API error for ${slug}: ${resp.status}`);
  }

  const data = await resp.json();
  const jobs = data.jobs || [];

  return jobs.map(job => {
    const comp = job.compensation || {};

    return normalize({
      companySlug: slug,
      company: data.organizationName || slug,
      title: job.title || '',
      department: job.department || '',
      location: job.location || '',
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

async function fetchAshbyGraphQL(slug) {
  const query = `{
    jobBoard {
      title
      jobPostings {
        id
        title
        locationName
        employmentType
        descriptionHtml
        publishedDate
        compensationTierSummary
      }
    }
  }`;

  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      operationName: 'ApiJobBoardWithTeams',
      variables: { organizationHostedJobsPageName: slug },
      query,
    }),
  });

  if (!resp.ok) return [];

  const data = await resp.json();
  const board = data.data?.jobBoard;
  if (!board) return [];

  const postings = board.jobPostings || [];

  return postings.map(job => normalize({
    companySlug: slug,
    company: board.title || slug,
    title: job.title || '',
    department: '',
    location: job.locationName || '',
    description: job.descriptionHtml || '',
    url: `https://jobs.ashbyhq.com/${slug}/${job.id}`,
    postedAt: job.publishedDate || null,
    salary: null,
    metadata: {
      ashbyId: job.id,
      employmentType: job.employmentType || '',
      compensationSummary: job.compensationTierSummary || '',
    },
  }, 'ashby'));
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

export async function hasAshby(slug) {
  try {
    const resp = await fetch(`${BOARD_URL}/${slug}`, { method: 'HEAD' });
    return resp.ok;
  } catch {
    return false;
  }
}
