import { normalize, stripHtml } from '../normalizer.js';

const BASE_URL = 'https://boards-api.greenhouse.io/v1/boards';

/**
 * Fetch all jobs from a Greenhouse job board.
 * Public API, no auth required.
 * Docs: https://developers.greenhouse.io/job-board.html
 *
 * @param {string} slug - Company slug (e.g., 'stripe', 'notion')
 * @returns {Promise<Array>} Normalized job objects
 */
export async function fetchGreenhouse(slug) {
  const url = `${BASE_URL}/${slug}/jobs?content=true`;
  const resp = await fetch(url);

  if (!resp.ok) {
    if (resp.status === 404) return []; // Company not found or no jobs
    throw new Error(`Greenhouse API error for ${slug}: ${resp.status}`);
  }

  const data = await resp.json();
  const jobs = data.jobs || [];

  return jobs.map(job => normalize({
    companySlug: slug,
    company: data.name || slug,
    title: job.title || '',
    department: job.departments?.[0]?.name || '',
    location: job.location?.name || '',
    description: stripHtml(job.content || ''),
    url: job.absolute_url || '',
    postedAt: job.updated_at || null,
    salary: null, // Greenhouse doesn't expose salary in public API
    metadata: {
      greenhouseId: job.id,
      internal_job_id: job.internal_job_id,
      departments: job.departments?.map(d => d.name) || [],
      offices: job.offices?.map(o => o.name) || [],
    },
  }, 'greenhouse'));
}

/**
 * Check if a company has a Greenhouse board.
 */
export async function hasGreenhouse(slug) {
  try {
    const resp = await fetch(`${BASE_URL}/${slug}`, { method: 'HEAD' });
    return resp.ok;
  } catch {
    return false;
  }
}
