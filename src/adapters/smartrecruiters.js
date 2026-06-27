import { normalize, stripHtml } from '../normalizer.js';

const BASE_URL = 'https://api.smartrecruiters.com/v1/companies';
const PAGE_SIZE = 100;

/**
 * Fetch all postings from a SmartRecruiters company.
 * Public API, no auth required.
 * Docs: https://developers.smartrecruiters.com/reference/postingsget-1
 *
 * Two-step flow (unavoidable N+1):
 *   - The postings LIST endpoint omits the job description entirely.
 *   - jd-intel's contract is "full JD text", so we must fetch each
 *     posting's DETAIL endpoint to get jobAd.sections.
 * Large enterprise tenants with hundreds of openings will therefore be
 * slow against SmartRecruiters specifically. This is the API's shape,
 * not a bug here.
 *
 * @param {string} slug - SmartRecruiters company identifier (e.g., 'Visa')
 * @returns {Promise<Array>} Normalized job objects
 */
export async function fetchSmartrecruiters(slug) {
  // 1. Page through the postings list.
  const postings = [];
  let offset = 0;

  while (true) {
    const listUrl = `${BASE_URL}/${slug}/postings?limit=${PAGE_SIZE}&offset=${offset}`;
    const resp = await fetch(listUrl);

    if (!resp.ok) {
      if (resp.status === 404) return []; // Company not found
      throw new Error(`SmartRecruiters API error for ${slug}: ${resp.status}`);
    }

    const data = await resp.json();
    const content = data.content || [];
    postings.push(...content);

    offset += PAGE_SIZE;
    if (content.length === 0 || offset >= (data.totalFound || 0)) break;
  }

  // 2. Fetch detail per posting for the description.
  const jobs = await Promise.all(postings.map(async (p) => {
    let sections = {};
    let postingUrl = '';

    try {
      const detailResp = await fetch(`${BASE_URL}/${slug}/postings/${p.id}`);
      if (detailResp.ok) {
        const detail = await detailResp.json();
        sections = detail.jobAd?.sections || {};
        postingUrl = detail.postingUrl || detail.applyUrl || '';
      }
    } catch {
      // Detail fetch failed: fall back to list-only fields (no description).
    }

    const description = [
      sections.jobDescription?.text,
      sections.qualifications?.text,
      sections.additionalInformation?.text,
    ].filter(Boolean).join('\n\n');

    const loc = p.location || {};
    const place = loc.fullLocation
      || [loc.city, loc.region, loc.country].filter(Boolean).join(', ');
    let location = place;
    if (loc.remote) location = `Remote - ${place}`.replace(/ - $/, ' ');
    else if (loc.hybrid) location = `Hybrid - ${place}`.replace(/ - $/, ' ');

    return normalize({
      companySlug: slug,
      company: p.company?.name || slug,
      title: p.name || '',
      department: p.department?.label || p.function?.label || '',
      location,
      description: stripHtml(description),
      url: postingUrl,
      postedAt: p.releasedDate || null,
      salary: null, // SmartRecruiters has no structured salary; normalizer parses text
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
 * Check if a company exists on SmartRecruiters.
 * (HEAD isn't reliably supported on the postings endpoint, so use a
 * minimal GET.)
 */
export async function hasSmartrecruiters(slug) {
  try {
    const resp = await fetch(`${BASE_URL}/${slug}/postings?limit=1`);
    if (!resp.ok) return false;
    // SmartRecruiters returns 200 with an empty page (not 404) for unknown
    // companies, so resp.ok alone false-positives on any slug. Confirm at
    // least one real posting exists before claiming a match.
    const data = await resp.json();
    return (data.totalFound || 0) > 0 || (data.content || []).length > 0;
  } catch {
    return false;
  }
}
