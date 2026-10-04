import { normalize, toIso } from '../normalizer.js';
import { atsErrorFromStatus } from '../errors.js';
import { atsFetch, probeResult } from '../http.js';
import { orgHost } from '../boards.js';

/**
 * Fetch jobs from a Recruitee career site.
 * Public API, no auth required.
 * Docs: https://docs.recruitee.com/reference/offers
 *
 * Single GET returns every offer inline — no N+1 (unlike SmartRecruiters),
 * no XML (unlike TeamTailor/Personio). The simplest adapter shape in the
 * toolkit.
 *
 * Each offer carries two HTML fields, `description` and `requirements`.
 * Which one holds the role depends on the tenant's template (and sometimes
 * the posting): some keep the duties in `description` and the candidate
 * profile in `requirements`, others put a company intro in `description`
 * and everything else in `requirements`. Neither alone is the posting, so
 * both are joined before normalize() strips them (issue #65).
 *
 * @param {string} slug - Recruitee company subdomain (e.g., 'vandebron')
 * @param {object} [ctx] - { report }; report is called once with
 *   { org_name, org_url } when given
 * @returns {Promise<Array>} Normalized job objects
 */
export async function fetchRecruitee(slug, ctx = {}) {
  const url = `https://${slug}.recruitee.com/api/offers/`;
  const resp = await atsFetch(url);

  if (!resp.ok) {
    if (resp.status === 404) return []; // No Recruitee site for this slug
    throw atsErrorFromStatus(resp.status, `Recruitee API error for ${slug}: ${resp.status}`);
  }

  const data = await resp.json();
  const offers = data.offers || [];

  // The response is { offers } only, so the identity lives on the rows:
  // company_name, and careers_url, which sits on the company's own careers
  // domain when the site has one and on {slug}.recruitee.com otherwise.
  if (typeof ctx.report === 'function') {
    ctx.report({
      org_name: offers.find(o => o.company_name)?.company_name || null,
      org_url: orgHost(offers.find(o => o.careers_url)?.careers_url),
    });
  }

  return offers.map(offer => {
    const place = [offer.city, offer.country].filter(Boolean).join(', ');
    let location = place;
    if (offer.remote) location = place ? `Remote - ${place}` : 'Remote';

    const createdAt = recruiteeDate(offer.created_at);

    return normalize({
      companySlug: slug,
      company: offer.company_name || slug,
      title: offer.title || '',
      department: offer.department || '',
      location,
      locations: (offer.locations || []).map(l => [l.city, l.country].filter(Boolean).join(', ')),
      workplace: parseRecruiteeWorkplace(offer),
      description: [offer.description, offer.requirements].filter(Boolean).join('\n'),
      url: offer.careers_url || offer.careers_apply_url || '',
      // created_at can predate publication by years on long-lived offers,
      // so it is not a posting date. published_at is.
      postedAt: recruiteeDate(offer.published_at) || createdAt,
      salary: parseRecruiteeSalary(offer.salary),
      metadata: {
        recruiteeId: offer.guid || offer.id,
        employmentType: offer.employment_type_code || '',
        category: offer.category_code || '',
        createdAt,
      },
    }, 'recruitee');
  });
}

// Recruitee returns "2026-05-13 07:38:11 UTC".
const recruiteeDate = (ts) => toIso(ts?.replace(' UTC', 'Z').replace(' ', 'T'));

/**
 * Recruitee sends three booleans, not one enum. Hybrid wins when remote is
 * also set, and on_site alone is onsite. All false is no signal.
 */
function parseRecruiteeWorkplace(offer) {
  if (offer.hybrid) return 'hybrid';
  if (offer.remote) return 'remote';
  if (offer.on_site) return 'onsite';
  return null;
}

const PERIODS = new Set(['year', 'month', 'hour']);

/**
 * Recruitee sends `salary` as `{min, max, period, currency}` with string
 * amounts. Offers without pay still carry the object, either all-null or
 * as a "0"/"0" placeholder, so anything without a positive side returns
 * null and normalize() falls back to the posting text.
 */
function parseRecruiteeSalary(salary) {
  if (!salary) return null;
  const min = toAmount(salary.min);
  const max = toAmount(salary.max);
  if (min === null && max === null) return null;
  return {
    min,
    max,
    currency: (salary.currency || '').toUpperCase(),
    period: PERIODS.has(salary.period) ? salary.period : null,
    source: 'ats',
  };
}

function toAmount(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Check if a company has a Recruitee career site. See probeResult for the outcomes.
 */
export async function hasRecruitee(slug) {
  const resp = await atsFetch(`https://${slug}.recruitee.com/api/offers/`);
  return probeResult(resp, `Recruitee probe for ${slug}`);
}
