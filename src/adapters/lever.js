import { normalize, extractSalaryFromText } from '../normalizer.js';
import { atsErrorFromStatus } from '../errors.js';

const BASE_URL = 'https://api.lever.co/v0/postings';

const PERIODS = { 'per-year-salary': 'year', 'per-month-salary': 'month', 'per-hour-wage': 'hour' };

/**
 * Fetch all jobs from a Lever job board.
 * Public API, no auth required.
 * Docs: https://github.com/lever/postings-api
 *
 * @param {string} slug - Company slug (e.g., 'stripe', 'figma')
 * @returns {Promise<Array>} Normalized job objects
 */
export async function fetchLever(slug) {
  const url = `${BASE_URL}/${slug}?mode=json`;
  const resp = await fetch(url);

  if (!resp.ok) {
    if (resp.status === 404) return [];
    throw atsErrorFromStatus(resp.status, `Lever API error for ${slug}: ${resp.status}`);
  }

  const jobs = await resp.json();
  if (!Array.isArray(jobs)) return [];

  return jobs.map(job => normalize({
    companySlug: slug,
    // Lever's API doesn't return the company name at the board or job level,
    // so the slug is the honest fallback. `categories.team` is the team within
    // the company ("Payments Platform"), not the company itself.
    company: titleCaseSlug(slug),
    title: job.text || '',
    department: job.categories?.department || job.categories?.team || '',
    location: job.categories?.location || '',
    description: buildDescription(job),
    url: job.hostedUrl || '',
    postedAt: job.createdAt ? new Date(job.createdAt).toISOString() : null,
    salary: parseLeverSalary(job.salaryRange, job.text),
    metadata: {
      leverId: job.id,
      team: job.categories?.team || '',
      commitment: job.categories?.commitment || '', // Full-time, Part-time, etc.
      workplaceType: job.workplaceType || '',
      salaryDescription: job.salaryDescriptionPlain || '',
    },
  }, 'lever'));
}

/**
 * Lever splits a posting across `description` (company intro plus overview),
 * `lists` (one `{text, content}` per section: responsibilities, requirements,
 * location details) and `additional` (benefits, EEO). Only the first used to
 * reach the description, so requirements were invisible to filters and to
 * the assistant (issue #64). Reassemble the whole posting as HTML and let
 * normalize() render the headings and bullets.
 */
function buildDescription(job) {
  const parts = [job.description || job.descriptionPlain || ''];
  for (const list of job.lists || []) {
    const heading = (list.text || '').trim();
    parts.push((heading ? `<h3>${escapeHtml(heading)}</h3>` : '') + (list.content || ''));
  }
  parts.push(job.additional || job.additionalPlain || '');
  return parts.filter(Boolean).join('\n');
}

// `lists[].text` is plain text ("Skills & Experience"). Escaped, normalize()
// decodes it back; raw, a stray `<` would be stripped as a tag.
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Lever publishes `salaryRange: {min, max, currency, interval}` on boards
 * that state pay. Boards that don't sometimes put the range in the title.
 */
function parseLeverSalary(range, title) {
  const min = range?.min || null;
  const max = range?.max || null;
  if (min || max) {
    return {
      min,
      max,
      currency: range.currency || 'USD',
      period: PERIODS[range.interval] || null,
      source: 'ats',
    };
  }
  return extractSalaryFromText(title || '');
}

function titleCaseSlug(slug) {
  if (!slug) return '';
  // "cockroachlabs" → "Cockroachlabs", "netflix" → "Netflix"
  // Best-effort display name; users should prefer companySlug for exact matching.
  return slug.charAt(0).toUpperCase() + slug.slice(1);
}

export async function hasLever(slug) {
  try {
    const resp = await fetch(`${BASE_URL}/${slug}?mode=json`, { method: 'HEAD' });
    return resp.ok;
  } catch {
    return false;
  }
}
