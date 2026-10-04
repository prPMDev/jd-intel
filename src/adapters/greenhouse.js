import { normalize, decodeEntities, periodWord } from '../normalizer.js';
import { atsErrorFromStatus } from '../errors.js';
import { atsFetch, probeResult } from '../http.js';

const BASE_URL = 'https://boards-api.greenhouse.io/v1/boards';

/**
 * Fetch all jobs from a Greenhouse job board.
 * Public API, no auth required.
 * Docs: https://developers.greenhouse.io/job-board.html
 *
 * @param {string} slug - Company slug (e.g., 'stripe', 'notion')
 * @param {object} [ctx] - { report }; report is called once with
 *   { org_name, org_url } when given
 * @returns {Promise<Array>} Normalized job objects
 */
export async function fetchGreenhouse(slug, ctx = {}) {
  // pay_transparency adds pay_input_ranges to each row (issue #86).
  const url = `${BASE_URL}/${slug}/jobs?content=true&pay_transparency=true`;
  const resp = await atsFetch(url);

  if (!resp.ok) {
    if (resp.status === 404) return []; // Company not found or no jobs
    throw atsErrorFromStatus(resp.status, `Greenhouse API error for ${slug}: ${resp.status}`);
  }

  const data = await resp.json();
  const jobs = data.jobs || [];

  // The list response has no top-level name, but each row carries the
  // board's company_name. Its only links are job-boards.greenhouse.io, so
  // there is no company host to report (issue #58).
  if (typeof ctx.report === 'function') {
    ctx.report({
      org_name: jobs.find(j => j.company_name)?.company_name || null,
      org_url: null,
    });
  }

  return jobs.map(job => {
    const payRanges = parsePayRanges(job.pay_input_ranges);
    return normalize({
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
      salary: salaryFromRanges(payRanges), // null without structured pay; normalize() then parses the text
      metadata: {
        greenhouseId: job.id,
        internal_job_id: job.internal_job_id,
        departments: job.departments?.map(d => d.name) || [],
        offices: job.offices?.map(o => o.name) || [],
        updatedAt: job.updated_at,
        payRanges,
      },
    }, 'greenhouse');
  });
}

/**
 * `pay_input_ranges` is the board's pay transparency data:
 * [{ min_cents, max_cents, currency_type, title, blurb }]. The blurb is
 * boilerplate already rendered in the description, so it is dropped, and
 * the platform can send the same entry twice, so entries are deduplicated.
 * A board that does not publish pay sends an empty array or no key.
 */
function parsePayRanges(ranges) {
  const seen = new Set();
  const out = [];
  for (const r of Array.isArray(ranges) ? ranges : []) {
    const range = {
      title: r.title || '',
      min: Number.isFinite(r.min_cents) ? r.min_cents / 100 : null,
      max: Number.isFinite(r.max_cents) ? r.max_cents / 100 : null,
      currency: r.currency_type || 'USD',
    };
    const key = JSON.stringify(range);
    if ((range.min === null && range.max === null) || seen.has(key)) continue;
    seen.add(key);
    out.push(range);
  }
  return out;
}

/**
 * One salary from the ranges. Ranges in one currency span (lowest min,
 * highest max), as the Ashby adapter does for its tiers; with mixed
 * currencies the first range stands alone. Every range stays in
 * metadata.payRanges. The field has no period, so the period is the one
 * the range titles state ("Annual", "Hourly") and null when they state
 * none or disagree: an 'ats' value carries no guessed period.
 */
function salaryFromRanges(ranges) {
  if (ranges.length === 0) return null;
  const used = ranges.every(r => r.currency === ranges[0].currency) ? ranges : [ranges[0]];
  const mins = used.map(r => r.min).filter(v => v !== null);
  const maxes = used.map(r => r.max).filter(v => v !== null);
  const periods = new Set(used.map(r => periodWord(r.title)));
  return {
    min: mins.length ? Math.min(...mins) : null,
    max: maxes.length ? Math.max(...maxes) : null,
    currency: used[0].currency,
    period: periods.size === 1 ? [...periods][0] : null,
    source: 'ats',
  };
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
 * Check if a company has a Greenhouse board. See probeResult for the outcomes.
 */
export async function hasGreenhouse(slug) {
  const resp = await atsFetch(`${BASE_URL}/${slug}`, { method: 'HEAD' });
  return probeResult(resp, `Greenhouse probe for ${slug}`);
}
