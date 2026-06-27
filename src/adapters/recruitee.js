import { normalize, stripHtml } from '../normalizer.js';
import { atsErrorFromStatus } from '../errors.js';

/**
 * Fetch jobs from a Recruitee career site.
 * Public API, no auth required.
 * Docs: https://docs.recruitee.com/reference/offers
 *
 * Single GET returns every offer with the full HTML description
 * inline — no N+1 (unlike SmartRecruiters), no XML (unlike
 * TeamTailor/Personio). The simplest adapter shape in the toolkit.
 *
 * @param {string} slug - Recruitee company subdomain (e.g., 'vandebron')
 * @returns {Promise<Array>} Normalized job objects
 */
export async function fetchRecruitee(slug) {
  const url = `https://${slug}.recruitee.com/api/offers/`;
  const resp = await fetch(url);

  if (!resp.ok) {
    if (resp.status === 404) return []; // No Recruitee site for this slug
    throw atsErrorFromStatus(resp.status, `Recruitee API error for ${slug}: ${resp.status}`);
  }

  const data = await resp.json();
  const offers = data.offers || [];

  return offers.map(offer => {
    const place = [offer.city, offer.country].filter(Boolean).join(', ');
    let location = place;
    if (offer.remote) location = place ? `Remote - ${place}` : 'Remote';

    let postedAt = null;
    if (offer.created_at) {
      // Recruitee returns "2026-05-13 07:38:11 UTC"; coerce to ISO.
      const iso = offer.created_at.replace(' UTC', 'Z').replace(' ', 'T');
      const d = new Date(iso);
      if (!Number.isNaN(d.getTime())) postedAt = d.toISOString();
    }

    return normalize({
      companySlug: slug,
      company: offer.company_name || slug,
      title: offer.title || '',
      department: offer.department || '',
      location,
      description: stripHtml(offer.description || ''),
      url: offer.careers_url || offer.careers_apply_url || '',
      postedAt,
      salary: null, // No structured salary; normalizer parses from text
      metadata: {
        recruiteeId: offer.guid || offer.id,
        employmentType: offer.employment_type_code || '',
        category: offer.category_code || '',
      },
    }, 'recruitee');
  });
}

/**
 * Check if a company has a Recruitee career site.
 */
export async function hasRecruitee(slug) {
  try {
    const resp = await fetch(`https://${slug}.recruitee.com/api/offers/`);
    return resp.ok;
  } catch {
    return false;
  }
}
