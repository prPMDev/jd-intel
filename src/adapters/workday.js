import { normalize, stripHtml } from '../normalizer.js';
import { atsErrorFromStatus } from '../errors.js';

const MAX_DETAIL_FETCHES = 100;
const LIST_PAGE_SIZE = 20;
const LIST_PAGE_HARD_CAP = 100; // <= 2000 list items scanned per request

/**
 * Fetch jobs from a Workday tenant via the public "CXS" JSON API.
 *
 * Workday's career-site SPA calls an unauthenticated JSON API. No
 * official docs, but it's stable and has no anti-bot at modest volume.
 *
 * REGISTRY-ONLY. Workday is keyed by an opaque {tenant, env, site}
 * triple that is NOT derivable from the company name (Bank of America's
 * tenant is `ghr`). So this adapter only works when called with
 * ctx.config from a registry entry; discovery-mode probing (no config)
 * bails instantly with zero network — see the guard below and
 * hasWorkday().
 *
 * Two-step like SmartRecruiters: a list endpoint (title/location/
 * postedOn, NO descriptions) plus a per-posting detail endpoint for
 * the full JD. Enterprise tenants are huge (Salesforce ~1398 jobs), so
 * we apply list-evaluable filters BEFORE detail-hydrating and cap the
 * detail set.
 *
 * @param {string} slug - normalized company slug (registry routing key)
 * @param {object} [ctx] - { config:{tenant,env,site}, companyName, filterContext }
 * @returns {Promise<Array>} Normalized job objects
 */
export async function fetchWorkday(slug, ctx = {}) {
  const cfg = ctx.config;
  if (!cfg || !cfg.tenant || !cfg.env || !cfg.site) return []; // registry-only guard

  const { tenant, env, site } = cfg;
  const base = `https://${tenant}.${env}.myworkdayjobs.com/wday/cxs/${tenant}/${site}`;
  const fc = ctx.filterContext || {};

  // 1. Page the cheap list (no descriptions in list responses).
  const postings = [];
  let offset = 0;
  let pages = 0;
  while (pages < LIST_PAGE_HARD_CAP) {
    const resp = await fetch(`${base}/jobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appliedFacets: {}, limit: LIST_PAGE_SIZE, offset, searchText: '' }),
    });

    if (!resp.ok) {
      if (resp.status === 404) return []; // wrong site / no such board
      if (offset === 0) {
        throw atsErrorFromStatus(resp.status, `Workday API error for ${slug} (${tenant}/${env}/${site}): ${resp.status}`);
      }
      break; // mid-paging failure: keep what we have
    }

    const data = await resp.json();
    const page = data.jobPostings || [];
    postings.push(...page);
    pages += 1;
    offset += LIST_PAGE_SIZE;
    if (page.length === 0 || offset >= (data.total || 0)) break;
  }

  // 2. Filter-aware candidate selection BEFORE the N+1 detail cost.
  //    The list carries title/locationsText/postedOn — enough to apply
  //    titleFilter, location, and recency without descriptions.
  let candidates = postings;

  if (fc.titleFilter) {
    const re = new RegExp(fc.titleFilter, 'i');
    candidates = candidates.filter(p => re.test(p.title || ''));
  }
  if (Array.isArray(fc.locationIncludes) && fc.locationIncludes.length > 0) {
    const inc = fc.locationIncludes.map(s => String(s).toLowerCase());
    candidates = candidates.filter(p => {
      const loc = (p.locationsText || '').toLowerCase();
      return inc.some(s => loc.includes(s));
    });
  }
  if (Array.isArray(fc.locationExcludes) && fc.locationExcludes.length > 0) {
    const exc = fc.locationExcludes.map(s => String(s).toLowerCase());
    candidates = candidates.filter(p => {
      const loc = (p.locationsText || '').toLowerCase();
      return !exc.some(s => loc.includes(s));
    });
  }
  if (typeof fc.postedWithinDays === 'number') {
    candidates = candidates.filter(p => withinDays(p.postedOn, fc.postedWithinDays));
  }

  // 3. Bound the detail-fetch set.
  //    NOTE: huge-tenant coverage is intentionally capped for v1
  //    (Salesforce ~1398 postings). A description `filter` is applied
  //    by the library AFTER this returns, so for that case we keep the
  //    full backstop instead of truncating tightly to `limit` (which
  //    could hydrate jobs that all fail the regex while better matches
  //    go unscanned). Proper fix (smart pagination / rate-limited
  //    concurrency / surfaced truncation) is tracked in #26, to be
  //    designed alongside retry/rate-limit work (#7).
  const limit = typeof fc.limit === 'number' && fc.limit > 0 ? fc.limit : 100;
  const cap = fc.filter ? MAX_DETAIL_FETCHES : Math.min(limit, MAX_DETAIL_FETCHES);
  candidates = candidates.slice(0, cap);

  // 4. Hydrate descriptions via the per-posting detail endpoint.
  const jobs = await Promise.all(candidates.map(async (p) => {
    const externalPath = p.externalPath || ''; // already begins with '/job/...'
    let info = {};
    try {
      // externalPath already carries the '/job/...' segment, so it is
      // concatenated directly onto the CXS base. Inserting another
      // '/job' here yields '/job/job/...' which Workday rejects (422).
      const dResp = await fetch(`${base}${externalPath}`);
      if (dResp.ok) {
        const detail = await dResp.json();
        info = detail.jobPostingInfo || {};
      }
    } catch {
      // detail failed: fall back to list fields, empty description
    }

    return normalize({
      companySlug: slug,
      company: ctx.companyName || slug,
      title: p.title || info.title || '',
      department: '',
      location: info.location || p.locationsText || '',
      description: stripHtml(info.jobDescription || ''),
      url: `https://${tenant}.${env}.myworkdayjobs.com/${site}${externalPath}`,
      postedAt: parseWorkdayDate(info.startDate) || normalizePostedOn(p.postedOn),
      salary: null, // normalizer extracts from description text
      metadata: {
        workdayTenant: tenant,
        workdayEnv: env,
        workdaySite: site,
        externalPath,
      },
    }, 'workday');
  }));

  return jobs;
}

/**
 * Workday list `postedOn` is a relative string ("Posted Today",
 * "Posted 5 Days Ago", "Posted 30+ Days Ago"). Decide membership in
 * the last N days WITHOUT a network call. Unparseable -> keep (true);
 * the library re-filters authoritatively on the real postedAt after
 * hydration, so a false-keep here is corrected downstream.
 */
function withinDays(postedOn, days) {
  if (!postedOn) return true;
  const s = String(postedOn).toLowerCase();
  if (/today/.test(s)) return days >= 0;
  if (/yesterday/.test(s)) return days >= 1;
  const m = s.match(/(\d+)\+?\s*days?\s*ago/);
  if (m) return parseInt(m[1], 10) <= days;
  return true;
}

/**
 * Coerce a Workday list `postedOn` (relative) into an approx ISO date
 * so the library's postedWithinDays re-filter has a value to compare.
 */
function normalizePostedOn(v) {
  if (!v) return null;
  const direct = new Date(v);
  if (Number.isFinite(direct.getTime())) return direct.toISOString();
  const s = String(v).toLowerCase();
  let daysAgo = null;
  if (/today/.test(s)) daysAgo = 0;
  else if (/yesterday/.test(s)) daysAgo = 1;
  else {
    const m = s.match(/(\d+)\+?\s*days?\s*ago/);
    if (m) daysAgo = parseInt(m[1], 10);
  }
  if (daysAgo === null) return null;
  return new Date(Date.now() - daysAgo * 86400000).toISOString();
}

/**
 * Workday detail `startDate` ("2026-05-01" or "May 1, 2026"). Return
 * ISO, or null if unparseable.
 */
function parseWorkdayDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * Registry-only invariant: the {tenant,env,site} triple can't be
 * probed from a company name. Always false so detect_ats never selects
 * Workday and discovery-mode fetchJobs bails via the config guard.
 */
export async function hasWorkday() {
  return false;
}
