/**
 * Register all three tools on the MCP server.
 *
 * Each handler:
 *   1. Validates args (Zod handles most of this)
 *   2. Calls the jd-intel library
 *   3. Maps the library's result or error onto the envelope: one status,
 *      one code, and metadata that says how the answer was reached
 *
 * Handlers stay thin — library does the work, MCP layer shapes the response.
 */

import { z } from 'zod';
import {
  fetchJobsDetailed,
  detectAtsDetailed as libDetectAtsDetailed,
  registry,
  ATS_NAMES,
  AtsError,
  ArgumentError,
} from 'jd-intel';

const { search: searchRegistry } = registry;
// Tolerate an older jd-intel that predates getSource. The bundle always
// vendors a matching version; this only guards a skewed local/global install.
const getRegistrySource = registry.getSource || (() => 'unknown');
import { success, partial, error, envelopeSchema } from './envelope.js';
import { ERROR_CODES } from './errors.js';
import { VERSION } from './version.js';
import {
  FETCH_JOBS,
  SEARCH_REGISTRY,
  DETECT_ATS,
} from './descriptions.js';

// Tool behavior hints for clients. All three tools only read; fetch_jobs and
// detect_ats reach out to live ATS APIs, search_registry reads the catalog.
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true };

const DEFAULT_LIMIT = 100;
const DEFAULT_MAX_TOKENS = 12000;

// detectAtsDetailed asks every adapter the registry did not answer for, but
// hasWorkday() answers false without a request: a Workday board is a
// (tenant, env, site) triple the slug does not reveal. metadata.attempted
// lists the live probes only, so Workday appears there never and in boards
// only from the registry.
const PROBEABLE = ATS_NAMES.filter((ats) => ats !== 'workday');

// est_tokens is chars/4 of the text block, so it is only known once the
// envelope holding it has been serialized. A few passes settle it: the digit
// count can change between the placeholder and the real value.
function estTokens(result) {
  return Math.ceil(result.content[0].text.length / 4);
}

function withEstTokens(wrap, jobs, metadata) {
  let result = wrap(jobs, { ...metadata, est_tokens: 0 });
  for (let pass = 0; pass < 3; pass++) {
    const est = estTokens(result);
    if (est === result.structuredContent.metadata.est_tokens) break;
    result = wrap(jobs, { ...metadata, est_tokens: est });
  }
  return result;
}

// Adds whole jobs in order until the next one would pass the budget. The
// candidate envelope is measured with the largest metadata this response
// could carry (the longest truncated reason, every count at its maximum), so
// the final envelope, whose metadata is the same size or smaller, stays
// within budget. "success" is also the longest status.
function fitToBudget(page, maxTokens, meta, total) {
  const longer = (a, b) => (JSON.stringify(a).length >= JSON.stringify(b).length ? a : b);
  const upper = {
    ...meta,
    truncated: { reason: 'scan_cap', not_returned: longer(total, null) },
    est_tokens: 999999,
    next_offset: longer(total, null),
  };
  let selected = [];
  for (const job of page) {
    const candidate = [...selected, job];
    const probe = success(candidate, { ...upper, count: candidate.length });
    if (selected.length > 0 && estTokens(probe) > maxTokens) break;
    selected = candidate;
  }
  return selected;
}

// One ATS when every board shares it, else null: a slug that answers on two
// platforms has no single ats, and boards says which.
function sharedAts(boards) {
  if (boards.length === 0) return null;
  const [first] = boards;
  return boards.every((b) => b.ats === first.ats) ? first.ats : null;
}

// No board answered and at least one check failed: rate_limited when any
// failure was a 429, else ats_unreachable. The same rule fetchJobs applies
// when it throws for a discovery that found nothing.
function outageCode(failed) {
  const limited = failed.some((f) => f.code === ERROR_CODES.RATE_LIMITED);
  return limited ? ERROR_CODES.RATE_LIMITED : ERROR_CODES.ATS_UNREACHABLE;
}

function outageMessage(company, failed) {
  const checks = failed.map((f) => `${f.ats} (${f.message})`).join('; ');
  return `No board answered for "${company}" and the check failed on ${checks}`;
}

const JOB = z
  .object({
    id: z.string(),
    company: z.string(),
    ats: z.string(),
    title: z.string(),
    location: z.string(),
    locations: z.array(z.string()).optional(),
    workplace: z.object({ type: z.string(), source: z.string().nullable() }).passthrough().optional(),
    description: z.string(),
    url: z.string(),
    postedAt: z.string().nullable().optional(),
  })
  .passthrough();

const REGISTRY_ENTRY = z
  .object({ slug: z.string(), name: z.string(), sector: z.string().optional(), ats: z.string() })
  .passthrough();

// An exception that escapes a handler would otherwise reach the model as the
// SDK's plain-text isError, with no envelope and no error.code. fetch_jobs maps
// AtsError and ArgumentError itself; this catches everything else.
function withEnvelope(handler) {
  return async (args, extra) => {
    try {
      return await handler(args, extra);
    } catch (err) {
      return error(ERROR_CODES.INTERNAL_ERROR, err?.message);
    }
  };
}

export function registerTools(server, deps = {}) {
  const _fetchJobsDetailed = deps.fetchJobsDetailed || fetchJobsDetailed;
  const _searchRegistry = deps.searchRegistry || searchRegistry;
  const _detectAtsDetailed = deps.detectAtsDetailed || libDetectAtsDetailed;

  server.registerTool(
    'fetch_jobs',
    {
      title: 'Fetch jobs from a company ATS',
      description: FETCH_JOBS,
      annotations: { ...READ_ONLY, openWorldHint: true },
      outputSchema: envelopeSchema(z.array(JOB).nullable()),
      inputSchema: z.object({
        company: z.string().describe('Company slug or name (e.g. "stripe")'),
        title_filter: z.string().optional().describe('Regex matched against title only: role identity'),
        filter: z.string().optional().describe('Regex matched across title, department, description: topic/scope'),
        posted_within_days: z.number().int().positive().optional().describe('Only jobs posted within N days'),
        location_includes: z.array(z.string()).optional().describe('Keep jobs where any listed location contains any keyword'),
        location_excludes: z.array(z.string()).optional().describe('Drop jobs only when every listed location contains a keyword'),
        limit: z.number().int().positive().optional().describe('Max jobs per page (default 100). max_tokens usually stops output first.'),
        offset: z.number().int().min(0).optional().describe('Matches to skip after sorting (default 0). Pass next_offset from the previous response to get the next page.'),
        order: z.enum(['newest', 'board']).optional().describe('"newest" (default): by postedAt, undated last. "board": the ATS\'s own order.'),
        max_tokens: z.number().int().min(1).optional().describe(`Response budget in tokens, chars/4 of the text block (default ${DEFAULT_MAX_TOKENS}, any integer from 1). Whole jobs only; at least one is always returned. Larger returns more complete postings per call; smaller is a quick scan.`),
        workday: z
          .object({
            tenant: z.string().trim().min(1).describe('Workday tenant, the first URL label, e.g. "expedia"'),
            env: z.string().trim().min(1).describe('Workday env/datacenter, e.g. "wd108", "wd5"'),
            site: z.string().trim().min(1).describe('Workday career-site path, e.g. "search", "Cisco_Careers"'),
          })
          .strict()
          .optional()
          .describe('Override the registry for a Workday board not indexed. Derive all three from the careers URL https://{tenant}.{env}.myworkdayjobs.com/{site}. Never guess these.'),
      }).strict(),
    },
    withEnvelope(async (args) => {
      // The schema already guarantees a complete, non-blank triple.
      const config = args.workday ? { ...args.workday } : undefined;
      const limit = args.limit ?? DEFAULT_LIMIT;
      const offset = args.offset ?? 0;
      const order = args.order ?? 'newest';
      const maxTokens = args.max_tokens ?? DEFAULT_MAX_TOKENS;

      let result;
      try {
        result = await _fetchJobsDetailed({
          company: args.company,
          ats: config ? 'workday' : undefined,
          config,
          titleFilter: args.title_filter,
          filter: args.filter,
          postedWithinDays: args.posted_within_days,
          locationIncludes: args.location_includes,
          locationExcludes: args.location_excludes,
          order,
          offset,
          limit,
        });
      } catch (err) {
        // AtsError and ArgumentError carry a stable .code, so the mapping
        // reads the code and never the message. Anything else is a bug, and
        // withEnvelope reports it as internal_error.
        if (err instanceof AtsError) {
          if (config && err.code === ERROR_CODES.ATS_UNREACHABLE) {
            // Keep the Workday triple-repair hint.
            return error(
              ERROR_CODES.ATS_UNREACHABLE,
              `Workday rejected ${config.tenant}/${config.env}/${config.site}: ${err.message}. Verify the triple against the careers URL https://{tenant}.{env}.myworkdayjobs.com/{site}.`
            );
          }
          return error(err.code, err.message);
        }
        if (err instanceof ArgumentError || err?.code === ERROR_CODES.INVALID_ARGS) {
          return error(ERROR_CODES.INVALID_ARGS, err.message);
        }
        throw err;
      }

      const { jobs: page, total_matched, total_before_filters, match, company, boards, failed } = result;

      // No board answered. With a failed check it is an outage, reported with
      // the failures; with every check complete and no registry row, the slug
      // is not there. A board whose rows all miss the filters is still a
      // board (issue #60), so that case never reaches here.
      if (boards.length === 0 && failed.length > 0) {
        return error(outageCode(failed), outageMessage(args.company, failed), { failed });
      }
      if (match === 'probe' && boards.length === 0) {
        return error(
          ERROR_CODES.COMPANY_NOT_FOUND,
          `No board answered for "${args.company}" on any probeable ATS and every check completed. Workday boards are registry-only; the workday argument reaches one the registry does not list.`
        );
      }

      // Workday and SmartRecruiters read at most their cap. With a capped
      // scan every count is a floor and not_returned cannot be stated.
      const countsExact = !boards.some((b) => b.scan?.capped === true);
      const meta = {
        count: 0,
        registry_hit: match === 'registry',
        ats: sharedAts(boards),
        workday_override: match === 'workday_override',
        version: VERSION,
        registry_source: getRegistrySource(),
        total_matched,
        total_before_filters,
        match,
        company,
        boards,
        failed,
        counts_exact: countsExact,
        truncated: null,
        offset,
        next_offset: null,
        order,
      };

      const jobs = fitToBudget(page, maxTokens, meta, total_matched);
      const notReturned = Math.max(0, total_matched - offset - jobs.length);
      let truncated = null;
      if (jobs.length < page.length) truncated = { reason: 'size', not_returned: countsExact ? notReturned : null };
      else if (notReturned > 0) truncated = { reason: 'limit', not_returned: countsExact ? notReturned : null };
      else if (!countsExact) truncated = { reason: 'scan_cap', not_returned: null };

      // A capped adapter hydrates only the rows the page needs (offset +
      // limit), so on a capped board total_matched equals offset + count
      // whenever the page fills and "matches remain" never fires while
      // most of the board is unread. A filled page on a capped board
      // therefore pages on; the page it names is empty once the cap itself
      // is the bound.
      const pagesOn = notReturned > 0 || (!countsExact && jobs.length === limit);

      return withEstTokens(failed.length > 0 ? partial : success, jobs, {
        ...meta,
        count: jobs.length,
        truncated,
        next_offset: pagesOn ? offset + jobs.length : null,
      });
    })
  );

  server.registerTool(
    'search_registry',
    {
      title: 'Search the company registry',
      description: SEARCH_REGISTRY,
      annotations: { ...READ_ONLY, openWorldHint: false },
      outputSchema: envelopeSchema(z.array(REGISTRY_ENTRY).nullable()),
      inputSchema: z.object({
        query: z.string().optional().describe('Case-insensitive substring match against company name or sector'),
        sector: z.string().optional().describe('Case-insensitive substring match against sector only (e.g. "fintech", "developer tools"). With query, both must match.'),
      }).strict(),
    },
    withEnvelope(async (args) => {
      if (!args.query && !args.sector) {
        return error(ERROR_CODES.INVALID_ARGS, 'Provide query or sector');
      }

      // searchRegistry matches one term against name or sector. With both
      // arguments, query is the term and sector then narrows the hits.
      const searchTerm = args.query || args.sector;
      const results = await _searchRegistry(searchTerm);

      const filtered = args.sector
        ? results.filter((r) => (r.sector || '').toLowerCase().includes(args.sector.toLowerCase()))
        : results;

      return success(filtered, {
        count: filtered.length,
        query: args.query || null,
        sector: args.sector || null,
        version: VERSION,
        registry_source: getRegistrySource(),
      });
    })
  );

  server.registerTool(
    'detect_ats',
    {
      title: 'Detect which ATS a company answers on',
      description: DETECT_ATS,
      annotations: { ...READ_ONLY, openWorldHint: true },
      outputSchema: envelopeSchema(z.string().nullable()),
      inputSchema: z.object({
        company: z.string().describe('Company name or slug'),
      }).strict(),
    },
    withEnvelope(async (args) => {
      const { boards, failed } = await _detectAtsDetailed(args.company);
      const registered = new Set(boards.filter((b) => b.source === 'registry').map((b) => b.ats));
      const meta = {
        attempted: PROBEABLE.filter((ats) => !registered.has(ats)),
        succeeded: boards.map((b) => b.ats),
        boards,
        failed,
      };

      if (boards.length === 0) {
        if (failed.length > 0) return error(outageCode(failed), outageMessage(args.company, failed), meta);
        return success(null, meta);
      }

      // Several boards: data is the first in platform order, which the
      // library guarantees, and the note says so. data as the whole list is
      // the next major (issue #87).
      if (boards.length > 1) {
        meta.notes = [
          `Boards on ${boards.length} platforms (${meta.succeeded.join(', ')}). data is the first in platform order, not a ranking; every board is in metadata.boards.`,
        ];
      }
      return (failed.length > 0 ? partial : success)(boards[0].ats, meta);
    })
  );
}
