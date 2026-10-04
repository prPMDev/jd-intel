import { normalize, missingContent } from '../normalizer.js';
import { atsErrorFromStatus } from '../errors.js';
import { prefilterRows } from '../filters.js';
import { atsFetch } from '../http.js';
import { orgHost } from '../boards.js';

const MAX_DETAIL_FETCHES = 100;
const LIST_PAGE_SIZE = 20;
// Upper bound on list pages per call: 100 pages of 20 = at most 2000
// postings scanned. Paging usually stops sooner, on a short page or when
// offset reaches the first page's total (see the loop below).
const LIST_PAGE_HARD_CAP = 100;
// A multi-location posting's list row reads "2 Locations", "14 Locations".
const MULTI_LOCATION = /^\s*\d+\s+locations?\s*$/;

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
 * @param {object} [ctx] - { config:{tenant,env,site}, companyName, filterContext, report };
 *   report is called once, after hydration, with
 *   { listed, prefiltered, hydrated, capped, org_name, org_url } when given
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
  let firstTotal = 0;
  let listCapped = false;
  while (true) {
    if (pages >= LIST_PAGE_HARD_CAP) {
      listCapped = true;
      break;
    }
    let resp;
    try {
      resp = await atsFetch(`${base}/jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appliedFacets: {}, limit: LIST_PAGE_SIZE, offset, searchText: '' }),
      });
    } catch (err) {
      // A 429 or 5xx that outlasted the retries, or a network failure.
      // After the first page, keep the postings already read.
      if (offset === 0) throw err;
      break;
    }

    if (!resp.ok) {
      if (offset === 0) {
        if (resp.status === 404) return []; // wrong site / no such board
        throw atsErrorFromStatus(resp.status, `Workday API error for ${slug} (${tenant}/${env}/${site}): ${resp.status}`);
      }
      break; // mid-paging failure (any status): keep what we have
    }

    const data = await resp.json();
    const page = data.jobPostings || [];
    // Some tenants report the real `total` only at offset 0 and send
    // `total: 0` on every later page, so only the first page's figure
    // is trusted. A short page is the other stop signal.
    if (pages === 0) firstTotal = data.total || 0;
    postings.push(...page);
    pages += 1;
    offset += LIST_PAGE_SIZE;
    if (page.length < LIST_PAGE_SIZE) break;
    if (firstTotal > 0 && offset >= firstTotal) break;
  }

  // 2. Filter-aware candidate selection BEFORE the N+1 detail cost, then
  //    the detail budget (see prefilterRows). The list carries
  //    title/locationsText/postedOn, enough to apply titleFilter, location
  //    and recency without descriptions. "2 Locations" says nothing about
  //    where: the row stays a candidate through both location filters and
  //    the library's pass after hydration decides on the detail's location
  //    list (issue #61).
  //    NOTE: huge-tenant coverage is intentionally capped for v1. Two caps
  //    apply: the list scan above stops at LIST_PAGE_HARD_CAP pages (2000
  //    postings, enough for Salesforce's ~1398), and the detail set is cut
  //    to MAX_DETAIL_FETCHES here. Proper fix (smart pagination, surfaced
  //    truncation) is tracked in #26.
  const { candidates, hydrate } = prefilterRows(postings, fc, {
    title: p => p.title || '',
    location: p => {
      const loc = (p.locationsText || '').toLowerCase();
      return MULTI_LOCATION.test(loc) ? null : loc;
    },
    postedWithin: (p, days) => withinDays(p.postedOn, days),
    max: MAX_DETAIL_FETCHES,
  });

  // 4. Hydrate descriptions via the per-posting detail endpoint. The detail
  //    also carries `hiringOrganization: { name, url }` next to
  //    jobPostingInfo; the list does not. Kept per posting in list order so
  //    the one reported is the first hydrated posting's, not whichever
  //    detail answered first (a tenant can post under several entities).
  const orgs = [];
  const jobs = await Promise.all(hydrate.map(async (p, i) => {
    const externalPath = p.externalPath || ''; // already begins with '/job/...'
    let info = {};
    let content; // set only when the detail could not be read (issue #85)
    try {
      // externalPath already carries the '/job/...' segment, so it is
      // concatenated directly onto the CXS base. Inserting another
      // '/job' here yields '/job/job/...' which Workday rejects (422).
      const dResp = await atsFetch(`${base}${externalPath}`);
      if (dResp.ok) {
        const detail = await dResp.json();
        info = detail.jobPostingInfo || {};
        orgs[i] = detail.hiringOrganization || null;
      } else {
        content = missingContent(dResp);
      }
    } catch (err) {
      // detail failed, retries included: list fields only, marked missing
      content = missingContent(err);
    }

    return normalize({
      companySlug: slug,
      company: ctx.companyName || slug,
      title: p.title || info.title || '',
      department: '',
      location: info.location || p.locationsText || '',
      locations: info.additionalLocations || [],
      workplace: parseWorkdayRemoteType(info.remoteType),
      description: info.jobDescription || '',
      url: `https://${tenant}.${env}.myworkdayjobs.com/${site}${externalPath}`,
      postedAt: parseWorkdayDate(info.startDate) || normalizePostedOn(p.postedOn),
      salary: null, // normalizer extracts from description text
      content,
      metadata: {
        workdayTenant: tenant,
        workdayEnv: env,
        workdaySite: site,
        externalPath,
      },
    }, 'workday');
  }));

  // Nothing hydrated (a filter miss, an empty site) means no detail was
  // read, so the org is unknown rather than absent: null, null.
  if (typeof ctx.report === 'function') {
    const org = orgs.find(Boolean) || {};
    ctx.report({
      listed: postings.length,
      prefiltered: candidates.length,
      hydrated: hydrate.length,
      capped: listCapped || hydrate.length < candidates.length,
      org_name: org.name || null,
      org_url: orgHost(org.url),
    });
  }

  return jobs;
}

/**
 * Detail `remoteType` is free text set per tenant: "Remote", "Hybrid",
 * "Office - Flexible", "On-site". A flexible office arrangement counts as
 * hybrid, so that check runs before the office one. Some tenants send no
 * value at all; the location string decides then.
 */
function parseWorkdayRemoteType(remoteType) {
  const s = String(remoteType || '').toLowerCase();
  if (/remote/.test(s)) return 'remote';
  if (/hybrid|flexible/.test(s)) return 'hybrid';
  if (/office|on-?site/.test(s)) return 'onsite';
  return null;
}

/**
 * Workday list `postedOn` is a relative string ("Posted Today",
 * "Posted 5 Days Ago", "Posted 30+ Days Ago"). The days it names, or null
 * when it names none.
 */
function daysAgo(postedOn) {
  const s = String(postedOn || '').toLowerCase();
  if (/today/.test(s)) return 0;
  if (/yesterday/.test(s)) return 1;
  const m = s.match(/(\d+)\+?\s*days?\s*ago/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Decide membership in the last N days WITHOUT a network call.
 * Unparseable -> keep (true); the library re-filters authoritatively on
 * the real postedAt after hydration, so a false-keep here is corrected
 * downstream.
 */
function withinDays(postedOn, days) {
  const n = daysAgo(postedOn);
  return n === null || n <= days;
}

/**
 * Coerce a Workday list `postedOn` (relative) into an approx ISO date
 * so the library's postedWithinDays re-filter has a value to compare.
 */
function normalizePostedOn(v) {
  if (!v) return null;
  const direct = new Date(v);
  if (Number.isFinite(direct.getTime())) return direct.toISOString();
  const n = daysAgo(v);
  return n === null ? null : new Date(Date.now() - n * 86400000).toISOString();
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
