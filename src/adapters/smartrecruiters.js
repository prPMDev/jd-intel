import { normalize } from '../normalizer.js';
import { atsErrorFromStatus } from '../errors.js';
import { atsFetch, probeResult } from '../http.js';
import { prefilterRows } from '../filters.js';

const BASE_URL = 'https://api.smartrecruiters.com/v1/companies';
const PAGE_SIZE = 100;
const MAX_DETAIL_FETCHES = 100;

/**
 * Fetch postings from a SmartRecruiters company.
 * Public API, no auth required.
 * Docs: https://developers.smartrecruiters.com/reference/postingsget-1
 *
 * Two-step flow (unavoidable N+1):
 *   - The postings LIST endpoint omits the job description entirely,
 *     and the structured `compensation` block with it.
 *   - jd-intel's contract is "full JD text", so we must fetch each
 *     posting's DETAIL endpoint to get jobAd.sections.
 *
 * The list does carry name, location and releasedDate, so the same
 * pre-filter and detail budget Workday applies run here: list-evaluable
 * filters narrow the candidates, then at most MAX_DETAIL_FETCHES of them
 * are hydrated (see prefilterRows). Without a filterContext the
 * cap still holds, so a direct call on a 400-posting tenant reads 100.
 *
 * @param {string} slug - SmartRecruiters company identifier (e.g., 'Visa')
 * @param {object} [ctx] - { filterContext, report }; report is called once
 *   with { listed, prefiltered, hydrated, capped, org_name, org_url }
 *   when given
 * @returns {Promise<Array>} Normalized job objects
 */
export async function fetchSmartrecruiters(slug, ctx = {}) {
  const fc = ctx.filterContext || {};

  // 1. Page through the postings list.
  const postings = [];
  let offset = 0;

  while (true) {
    const listUrl = `${BASE_URL}/${slug}/postings?limit=${PAGE_SIZE}&offset=${offset}`;
    const resp = await atsFetch(listUrl);

    if (!resp.ok) {
      if (resp.status === 404) return []; // Company not found
      throw atsErrorFromStatus(resp.status, `SmartRecruiters API error for ${slug}: ${resp.status}`);
    }

    const data = await resp.json();
    const content = data.content || [];
    postings.push(...content);

    offset += PAGE_SIZE;
    if (content.length === 0 || offset >= (data.totalFound || 0)) break;
  }

  // 2. Filter-aware candidate selection BEFORE the N+1 detail cost, then
  //    the detail budget (see prefilterRows). The list row carries name,
  //    location and releasedDate. The detail adds no location (unlike
  //    Workday's additionalLocations), so a row with none follows the
  //    library's rule now: out under includes, kept under excludes.
  //    postedAt comes from releasedDate alone, so a missing or unparseable
  //    date is out, as it is in the library.
  const { candidates, hydrate } = prefilterRows(postings, fc, {
    title: p => p.name || '',
    location: p => listLocation(p).location.toLowerCase(),
    postedWithin: (p, days) => {
      const released = new Date(p.releasedDate || '').getTime();
      return Number.isFinite(released) && released >= Date.now() - days * 86400000;
    },
    max: MAX_DETAIL_FETCHES,
  });

  // Every list row carries company { identifier, name }. Neither the list
  // nor the detail has a company website, and postingUrl is always on
  // jobs.smartrecruiters.com, so org_url stays null (issue #58).
  if (typeof ctx.report === 'function') {
    ctx.report({
      listed: postings.length,
      prefiltered: candidates.length,
      hydrated: hydrate.length,
      capped: hydrate.length < candidates.length,
      org_name: postings.find(p => p.company?.name)?.company.name || null,
      org_url: null,
    });
  }

  // 4. Fetch detail per candidate for the description. atsFetch's per-host
  //    queue keeps this fan-out to 4 requests at a time (a 412-posting
  //    tenant measured 53s unbounded), so the cap also holds the detail
  //    step to roughly 13s.
  const jobs = await Promise.all(hydrate.map(async (p) => {
    let sections = {};
    let postingUrl = '';
    let salary = null;

    try {
      const detailResp = await atsFetch(`${BASE_URL}/${slug}/postings/${p.id}`);
      if (detailResp.ok) {
        const detail = await detailResp.json();
        sections = detail.jobAd?.sections || {};
        postingUrl = detail.postingUrl || detail.applyUrl || '';
        salary = parseCompensation(detail.compensation);
      }
    } catch {
      // Detail fetch failed, retries included: fall back to list-only
      // fields (no description). Reporting this is #85.
    }

    const description = [
      sections.jobDescription?.text,
      sections.qualifications?.text,
      sections.additionalInformation?.text,
    ].filter(Boolean).join('\n\n');

    const { location, workplace } = listLocation(p);

    return normalize({
      companySlug: slug,
      company: p.company?.name || slug,
      title: p.name || '',
      department: p.department?.label || p.function?.label || '',
      location,
      workplace,
      description,
      url: postingUrl,
      postedAt: p.releasedDate || null,
      salary, // null when the detail has no compensation; normalize() then parses text
      metadata: {
        smartRecruitersId: p.id,
        refNumber: p.refNumber || '',
        function: p.function?.label || '',
        experienceLevel: p.experienceLevel?.label || '',
        typeOfEmployment: p.typeOfEmployment?.label || '',
      },
    }, 'smartrecruiters');
  }));

  return jobs;
}

/**
 * The location string and workplace type a list row yields. Built once
 * here so the pre-filter matches exactly what the normalized job carries,
 * "Remote - " and "Hybrid - " prefixes included.
 */
function listLocation(p) {
  const loc = p.location || {};
  const place = loc.fullLocation
    || [loc.city, loc.region, loc.country].filter(Boolean).join(', ');
  if (loc.remote) return { location: `Remote - ${place}`.replace(/ - $/, ' '), workplace: 'remote' };
  if (loc.hybrid) return { location: `Hybrid - ${place}`.replace(/ - $/, ' '), workplace: 'hybrid' };
  return { location: place, workplace: null };
}

const PERIODS = { YEARLY: 'year', MONTHLY: 'month', HOURLY: 'hour' };

/**
 * Map the detail response's `compensation` to the shared salary shape.
 *
 * SmartRecruiters publishes `{min?, max?, currency, period}`, and both
 * one-sided cases occur (a "max only" cap, a "from" floor), so each bound
 * is passed through as null when absent rather than dropping the whole
 * range. The period is kept as published: a MONTHLY figure is not
 * annualized because tenants occasionally mislabel it (issue #70).
 */
function parseCompensation(comp) {
  if (!comp || !comp.currency) return null;
  const min = Number.isFinite(comp.min) ? comp.min : null;
  const max = Number.isFinite(comp.max) ? comp.max : null;
  if (min === null && max === null) return null;
  return {
    min,
    max,
    currency: comp.currency,
    period: PERIODS[comp.period] ?? null,
    source: 'ats',
  };
}

/**
 * Check if a company exists on SmartRecruiters. See probeResult for the
 * outcomes. (HEAD isn't reliably supported on the postings endpoint, so
 * use a minimal GET.)
 */
export async function hasSmartrecruiters(slug) {
  const resp = await atsFetch(`${BASE_URL}/${slug}/postings?limit=1`);
  if (!probeResult(resp, `SmartRecruiters probe for ${slug}`)) return false;
  // SmartRecruiters returns 200 with an empty page (not 404) for unknown
  // companies, so resp.ok alone false-positives on any slug. Confirm at
  // least one real posting exists before claiming a match.
  const data = await resp.json();
  return (data.totalFound || 0) > 0 || (data.content || []).length > 0;
}
