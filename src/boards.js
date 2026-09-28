/**
 * The boards[] entry of a fetchJobsDetailed result (issues #58, #60, #87).
 *
 * A board is one (ats, slug) the library fetched, with what came back. The
 * fields fall in three groups: what the registry or the caller said about
 * it (`name`, `site`), what the fetch found (`jobs_found`, `matched`,
 * `scan`), and what the board says about itself (`org_name`, `org_url`).
 * Only the adapters can read the third group, and they hand it over through
 * ctx.report. Both fields are null where the platform exposes nothing, and
 * they are never filled from the slug or the registry name: a slug is an
 * address, not a confirmed identity.
 */

const BOARD_URLS = {
  greenhouse: (slug) => `https://boards.greenhouse.io/${slug}`,
  lever: (slug) => `https://jobs.lever.co/${slug}`,
  ashby: (slug) => `https://jobs.ashbyhq.com/${slug}`,
  smartrecruiters: (slug) => `https://careers.smartrecruiters.com/${slug}`,
  teamtailor: (slug) => `https://${slug}.teamtailor.com`,
  recruitee: (slug) => `https://${slug}.recruitee.com`,
  workday: (slug, config) => (config ? `https://${config.tenant}.${config.env}.myworkdayjobs.com/${config.site}` : null),
};

// Domains the platforms own. A link there (boards.greenhouse.io,
// jobs.lever.co, testco.recruitee.com, cisco.wd5.myworkdayjobs.com) says
// which ATS hosts the board, nothing about whose board it is.
const ATS_DOMAINS = ['greenhouse.io', 'lever.co', 'ashbyhq.com', 'smartrecruiters.com', 'teamtailor.com', 'recruitee.com', 'myworkdayjobs.com'];

/**
 * The page a person opens to see the board, or null when the ATS is unknown
 * or, for Workday, no {tenant, env, site} is at hand.
 */
export function boardUrl(ats, slug, config) {
  const build = BOARD_URLS[ats];
  return build ? build(slug, config) : null;
}

/**
 * The bare hostname a board's link points at ("jobs.example.com"), for
 * org_url. Null when the link is missing or malformed, and null when the
 * host belongs to an ATS, since that carries no signal about the company.
 */
export function orgHost(link) {
  let host;
  try {
    host = new URL(link).hostname.toLowerCase();
  } catch {
    return null;
  }
  if (!host || ATS_DOMAINS.some(d => host === d || host.endsWith(`.${d}`))) return null;
  return host;
}

/**
 * @param {object} board
 * @param {string} board.ats
 * @param {string} board.slug - The slug the adapter was called with (canonical casing on a registry hit)
 * @param {string|null} board.name - Registry row name; null for a probe or an override
 * @param {object} [board.config] - Workday {tenant, env, site}, when one was used
 * @param {string|null} board.org_name - The organization name the ATS response states, else null
 * @param {string|null} board.org_url - The careers or company host the board links to (see orgHost), else null
 * @param {number} board.jobs_found - Rows the board listed before any filter: the list count an adapter reported through ctx.report when it filters before hydrating, else the rows it returned
 * @param {number} board.matched - Rows left after filters, before offset and limit
 * @param {object|null} board.scan - The { listed, prefiltered, hydrated, capped } counts the adapter reported through ctx.report, else null
 */
export function describeBoard({ ats, slug, name = null, config, org_name = null, org_url = null, jobs_found, matched = 0, scan = null }) {
  return {
    ats,
    slug,
    name,
    site: ats === 'workday' && config ? config.site : null,
    board_url: boardUrl(ats, slug, config),
    org_name,
    org_url,
    jobs_found,
    matched,
    selected: true,
    scan,
  };
}
