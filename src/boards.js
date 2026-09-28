/**
 * The boards[] entry of a fetchJobsDetailed result (issues #58, #60, #87).
 *
 * A board is one (ats, slug) the library fetched, with what came back. The
 * fields fall in two groups: what the registry or the caller said about it
 * (`name`, `site`), and what the fetch found (`jobs_found`, `matched`,
 * `scan`). `org_name` and `org_url` belong to a third group, what the board
 * says about itself. Only the adapters can read that, and none does yet, so
 * both are null here. They are never filled from the slug: a slug is an
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

/**
 * The page a person opens to see the board, or null when the ATS is unknown
 * or, for Workday, no {tenant, env, site} is at hand.
 */
export function boardUrl(ats, slug, config) {
  const build = BOARD_URLS[ats];
  return build ? build(slug, config) : null;
}

/**
 * @param {object} board
 * @param {string} board.ats
 * @param {string} board.slug - The slug the adapter was called with (canonical casing on a registry hit)
 * @param {string|null} board.name - Registry row name; null for a probe or an override
 * @param {object} [board.config] - Workday {tenant, env, site}, when one was used
 * @param {number} board.jobs_found - Rows the board listed before any filter: the list count an adapter reported through ctx.report when it filters before hydrating, else the rows it returned
 * @param {number} board.matched - Rows left after filters, before offset and limit
 * @param {object|null} board.scan - What the adapter reported through ctx.report, else null
 */
export function describeBoard({ ats, slug, name = null, config, jobs_found, matched = 0, scan = null }) {
  return {
    ats,
    slug,
    name,
    site: ats === 'workday' && config ? config.site : null,
    board_url: boardUrl(ats, slug, config),
    org_name: null,
    org_url: null,
    jobs_found,
    matched,
    selected: true,
    scan,
  };
}
