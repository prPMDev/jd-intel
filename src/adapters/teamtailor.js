import { normalize, decodeEntities, toIso } from '../normalizer.js';
import { atsErrorFromStatus } from '../errors.js';
import { atsFetch } from '../http.js';
import { orgHost } from '../boards.js';

/**
 * Fetch jobs from a TeamTailor career site via its public RSS feed.
 *
 * Why RSS, not the official API:
 *   TeamTailor's REST API (api.teamtailor.com/v1/jobs) requires a
 *   per-company API key — 401 without it. Unusable for a public
 *   registry tool that probes arbitrary companies. The public,
 *   unauthenticated path is the career site's jobs.rss feed, which
 *   carries the full HTML job description (jd-intel's whole point).
 *
 * Slug maps to `{slug}.teamtailor.com`. The /jobs.rss path serves
 * directly on that subdomain even when the site root 301-redirects
 * to a custom domain (e.g. jobs.tibber.com).
 *
 * RSS quirk: descriptions are HTML-entity-encoded inside the XML
 * (`&lt;p&gt;...`). We decode that outer layer to real HTML with the
 * shared decodeEntities() and hand the HTML to normalize(), which
 * strips tags and resolves the inner entities. Decode order matters —
 * `&amp;` resolves LAST so double-encoded sequences (`&amp;amp;`)
 * collapse by one layer per pass.
 *
 * @param {string} slug - TeamTailor career-site slug (e.g., 'tibber')
 * @param {object} [ctx] - { report }; report is called once with
 *   { org_name, org_url } when given
 * @returns {Promise<Array>} Normalized job objects
 */
// Most sites are {slug}.teamtailor.com, but some sit on a regional
// segment, e.g. crunchbase.na.teamtailor.com. '' is the base host. There
// is no reachable eu segment: {slug}.eu.teamtailor.com fails TLS for every
// slug, known or not, because the wildcard certificate covers one label
// only (live check 2026-09-27). Probing it was a guaranteed failure that
// the has() contract would now report as an outage.
const TT_REGIONS = ['', 'na'];

// Feeds send `none`, `hybrid`, `fully` or `onsite`. `none` is no signal.
const REMOTE_STATUS = { hybrid: 'hybrid', fully: 'remote', onsite: 'onsite' };

/**
 * Resolve which TeamTailor host actually serves this slug's feed.
 * Returns the first 200 Response, throws on a non-404 error (atsFetch
 * throws the 429, 5xx and network cases itself), or returns null if no
 * region has a feed.
 */
async function resolveFeed(slug, method = 'GET') {
  for (const region of TT_REGIONS) {
    const host = region
      ? `${slug}.${region}.teamtailor.com`
      : `${slug}.teamtailor.com`;
    const resp = await atsFetch(`https://${host}/jobs.rss`, {
      method,
      redirect: 'follow',
    });
    if (resp.ok) return resp;
    if (resp.status !== 404) {
      throw atsErrorFromStatus(resp.status, `TeamTailor RSS error for ${slug}: ${resp.status}`);
    }
    // 404 on this host — try the next region.
  }
  return null;
}

export async function fetchTeamtailor(slug, ctx = {}) {
  const resp = await resolveFeed(slug, 'GET');
  if (!resp) return []; // No TeamTailor site in any known region

  const xml = await resp.text();

  const channelTitle = (xml.match(/<channel>[\s\S]*?<title>([\s\S]*?)<\/title>/)?.[1] || '').trim();
  const company = channelTitle || slug;

  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)].map(m => m[1]);

  // The channel title is the company as the site names itself. The channel
  // <link> always sits on {slug}.teamtailor.com, but item links follow the
  // site's custom domain when it has one (jobs.tibber.com on a feed served
  // from tibber.teamtailor.com), so the first item's link is the host that
  // can say something; the channel link is the fallback for an empty feed.
  if (typeof ctx.report === 'function') {
    const link = items[0]?.match(/<link>([\s\S]*?)<\/link>/)?.[1]
      || xml.match(/<channel>[\s\S]*?<link>([\s\S]*?)<\/link>/)?.[1]
      || '';
    ctx.report({
      org_name: decodeEntities(channelTitle) || null,
      org_url: orgHost(link.trim()),
    });
  }

  return items.map(item => {
    const pick = (tag, src = item) => {
      const m = src.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
      return m ? m[1].trim() : '';
    };

    const title = decodeEntities(pick('title'));
    const link = pick('link');
    const guid = pick('guid');
    const pubDateRaw = pick('pubDate');
    const department = decodeEntities(pick('tt:department'));
    const city = decodeEntities(pick('tt:city'));
    const country = decodeEntities(pick('tt:country'));
    const remoteStatus = decodeEntities(pick('remoteStatus'));

    // One <tt:location> per office the posting is open in, read the same
    // way as the primary above so the entries line up.
    const locations = [...item.matchAll(/<tt:location>([\s\S]*?)<\/tt:location>/g)].map(m =>
      [decodeEntities(pick('tt:city', m[1])), decodeEntities(pick('tt:country', m[1]))].filter(Boolean).join(', ')
    );

    let location = [city, country].filter(Boolean).join(', ');
    if (/remote/i.test(remoteStatus)) {
      location = location ? `Remote - ${location}` : 'Remote';
    }

    return normalize({
      companySlug: slug,
      company,
      title,
      department,
      location,
      locations,
      workplace: REMOTE_STATUS[remoteStatus.toLowerCase()] || null,
      description: decodeEntities(pick('description')),
      url: link,
      postedAt: toIso(pubDateRaw),
      salary: null, // No structured salary; normalizer parses from text
      metadata: {
        teamtailorId: guid,
        remoteStatus,
      },
    }, 'teamtailor');
  });
}

/**
 * Check if a company has a TeamTailor career site: true when a regional
 * host serves the feed, false when every host answers 404, and the
 * AtsError from resolveFeed for anything else.
 */
export async function hasTeamtailor(slug) {
  return (await resolveFeed(slug, 'HEAD')) !== null;
}
