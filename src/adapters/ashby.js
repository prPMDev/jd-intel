import { normalize } from '../normalizer.js';

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
    throw new Error(`Ashby REST API error for ${slug}: ${resp.status}`);
  }

  const data = await resp.json();
  const jobs = data.jobs || [];

  return jobs.map(job => {
    const salary = parseAshbyCompensation(job.compensation);

    return normalize({
      companySlug: slug,
      company: data.organizationName || slug,
      title: job.title || '',
      department: job.departmentName || '',
      location: job.location || '',
      description: job.descriptionHtml || job.descriptionPlain || '',
      url: `https://jobs.ashbyhq.com/${slug}/${job.id}`,
      postedAt: job.publishedAt || null,
      salary,
      metadata: {
        ashbyId: job.id,
        employmentType: job.employmentType || '',
        isRemote: job.isRemote || false,
        team: job.teamName || '',
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

function parseAshbyCompensation(comp) {
  if (!comp) return null;
  // Ashby compensation can be a string or structured object
  if (typeof comp === 'string') {
    const match = comp.match(/\$?([\d,]+)\s*[-–]\s*\$?([\d,]+)/);
    if (!match) return null;
    return {
      min: parseInt(match[1].replace(/,/g, '')),
      max: parseInt(match[2].replace(/,/g, '')),
      currency: 'USD',
    };
  }
  if (comp.min && comp.max) {
    return { min: comp.min, max: comp.max, currency: comp.currency || 'USD' };
  }
  return null;
}

export async function hasAshby(slug) {
  try {
    const resp = await fetch(`${BOARD_URL}/${slug}`, { method: 'HEAD' });
    return resp.ok;
  } catch {
    return false;
  }
}
