import { normalize, decodeEntities, toIso } from '../normalizer.js';
import { atsErrorFromStatus } from '../errors.js';
import { atsFetch } from '../http.js';

/**
 * Fetch jobs from a Personio career site via its public XML feed.
 *
 * `{slug}.jobs.personio.de/xml` is the unauthenticated feed Personio
 * publishes for job-board integrations. One GET returns every open
 * position with its full description, split into titled sections
 * ("Your mission", "Your profile"), each an HTML fragment inside CDATA.
 *
 * Existence is read from the status, not the body: a career site with
 * nothing open answers 200 with an empty <workzag-jobs>, and a slug with
 * no site answers 307 to personio.com. So the request must not follow
 * redirects, or every unknown slug would read as a marketing page.
 *
 * The feed names no company. `subcompany` is the hiring legal entity
 * where the tenant set one, so it is what the board states about itself.
 *
 * @param {string} slug - Personio career-site subdomain (e.g., 'holidu')
 * @param {object} [ctx] - { companyName, report }; report is called once with
 *   { org_name, org_url } when given
 * @returns {Promise<Array>} Normalized job objects
 */
export async function fetchPersonio(slug, ctx = {}) {
  const resp = await requestFeed(slug);
  if (!resp) return []; // No Personio career site for this slug

  const xml = await resp.text();
  const positions = [...xml.matchAll(/<position>([\s\S]*?)<\/position>/g)].map(m => m[1]);
  const pick = (src, tag) => decodeEntities(src.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1].trim() || '');

  // Every link is on jobs.personio.de, so there is no company host to report.
  if (typeof ctx.report === 'function') {
    ctx.report({ org_name: positions.map(p => pick(p, 'subcompany')).find(Boolean) || null, org_url: null });
  }

  return positions.map(raw => {
    // The posting's own fields, without the sections: each section has a
    // <name> of its own.
    const position = raw.replace(/<jobDescriptions>[\s\S]*<\/jobDescriptions>/, '');
    const id = pick(position, 'id');
    // The primary <office>, then any under <additionalOffices>.
    const offices = [...position.matchAll(/<office>([\s\S]*?)<\/office>/g)].map(m => decodeEntities(m[1].trim()));

    return normalize({
      companySlug: slug,
      // The feed names no company; subcompany is a legal entity that varies
      // per posting, so it goes to metadata and the registry name labels the job.
      company: ctx.companyName || slug,
      title: pick(position, 'name'),
      department: pick(position, 'department'),
      location: offices[0] || '',
      locations: offices,
      workplace: null, // The feed has no remote/hybrid field; the location string decides.
      description: buildDescription(raw),
      url: id ? `https://${slug}.jobs.personio.de/job/${id}` : '',
      postedAt: toIso(pick(position, 'createdAt')),
      salary: null, // No structured salary; normalizer parses from text
      metadata: {
        personioId: id,
        subcompany: pick(position, 'subcompany'),
        recruitingCategory: pick(position, 'recruitingCategory'),
        employmentType: pick(position, 'employmentType'),
        seniority: pick(position, 'seniority'),
        schedule: pick(position, 'schedule'),
        yearsOfExperience: pick(position, 'yearsOfExperience'),
      },
    }, 'personio');
  });
}

/**
 * The feed response, or null when the slug has no career site (a redirect
 * or a 404). atsFetch throws the 429, 5xx and network cases itself.
 */
async function requestFeed(slug) {
  const resp = await atsFetch(`https://${slug}.jobs.personio.de/xml?language=en`, { redirect: 'manual' });
  if (resp.ok) return resp;
  if (resp.status === 404 || (resp.status >= 300 && resp.status < 400)) return null;
  throw atsErrorFromStatus(resp.status, `Personio feed error for ${slug}: ${resp.status}`);
}

/**
 * One posting's sections as HTML: each <jobDescription> is a plain-text
 * <name> heading and a CDATA <value> that already holds HTML. Only the
 * CDATA wrapper comes off here; normalize() strips and decodes the rest,
 * once (see normalizer.js).
 */
function buildDescription(position) {
  return [...position.matchAll(/<jobDescription>([\s\S]*?)<\/jobDescription>/g)].map(([, section]) => {
    const heading = section.match(/<name>([\s\S]*?)<\/name>/)?.[1].trim() || '';
    const value = (section.match(/<value>([\s\S]*?)<\/value>/)?.[1] || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
    return (heading ? `<h3>${heading}</h3>` : '') + value;
  }).filter(Boolean).join('\n');
}

/**
 * Check if a company has a Personio career site: true when the feed
 * answers, false on a redirect or a 404, and the AtsError from requestFeed
 * for anything else.
 */
export async function hasPersonio(slug) {
  return (await requestFeed(slug)) !== null;
}
