import { normalize, decodeEntities } from '../normalizer.js';
import { atsErrorFromStatus } from '../errors.js';

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
    throw atsErrorFromStatus(resp.status, `Greenhouse API error for ${slug}: ${resp.status}`);
  }

  const data = await resp.json();
  const jobs = data.jobs || [];

  return jobs.map(job => normalize({
    companySlug: slug,
    company: data.name || slug,
    title: job.title || '',
    department: job.departments?.[0]?.name || '',
    location: job.location?.name || '',
    workplace: parseGreenhouseWorkplace(job.metadata),
    // `content` arrives HTML-escaped (`&lt;p&gt;`). Decode that outer layer
    // once so normalize() sees real tags; it strips and decodes the rest.
    description: decodeEntities(job.content || ''),
    url: job.absolute_url || '',
    // updated_at is an edit time that many boards bulk-refresh, so it is not
    // a posting date. first_published is. Fallback covers boards without it (#69).
    postedAt: job.first_published || job.updated_at || null,
    salary: null, // list endpoint has no structured pay; normalizer parses the pay transparency text
    metadata: {
      greenhouseId: job.id,
      internal_job_id: job.internal_job_id,
      departments: job.departments?.map(d => d.name) || [],
      offices: job.offices?.map(o => o.name) || [],
      updatedAt: job.updated_at,
    },
  }, 'greenhouse'));
}

/**
 * Greenhouse has no native workplace field. Boards that track it define a
 * custom field ("Location Type", "Workplace Type") that arrives in the
 * job's `metadata[]`, with `value` a string for single-select fields and
 * an array for multi-select. Values seen: On-Site, Hybrid (Travel-Required),
 * Remote. Anything else is no signal and the location string decides.
 */
function parseGreenhouseWorkplace(metadata) {
  const field = (metadata || []).find(m => /location type|workplace type/i.test(m?.name || ''));
  if (!field) return null;
  const value = [].concat(field.value ?? []).join(' ').toLowerCase();
  if (/remote/.test(value)) return 'remote';
  if (/hybrid/.test(value)) return 'hybrid';
  if (/on-?site/.test(value)) return 'onsite';
  return null;
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
