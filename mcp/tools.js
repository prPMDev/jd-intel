/**
 * Register all three tools on the MCP server.
 *
 * Each handler:
 *   1. Validates args (Zod handles most of this)
 *   2. Calls the jd-intel library
 *   3. Wraps the result in the uniform envelope
 *
 * Handlers stay thin — library does the work, MCP layer shapes the response.
 */

import { z } from 'zod';
import { fetchJobsDetailed, detectAts as libDetectAts, registry, ATS_NAMES, AtsError } from 'jd-intel';

const { search: searchRegistry, findAtsBySlug } = registry;
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
const MIN_MAX_TOKENS = 2000;
const MAX_MAX_TOKENS = 40000;

// est_tokens is chars/4 of the text block, so it is only known once the
// envelope holding it has been serialized. A few passes settle it: the digit
// count can change between the placeholder and the real value.
function estTokens(result) {
  return Math.ceil(result.content[0].text.length / 4);
}

function successWithEstTokens(jobs, metadata) {
  let result = success(jobs, { ...metadata, est_tokens: 0 });
  for (let pass = 0; pass < 3; pass++) {
    const est = estTokens(result);
    if (est === result.structuredContent.metadata.est_tokens) break;
    result = success(jobs, { ...metadata, est_tokens: est });
  }
  return result;
}

// Adds whole jobs in order until the next one would pass the budget. The
// candidate envelope is measured with the largest metadata this response
// could carry (a "limit" cut, every count at its maximum), so the final
// envelope, whose metadata is the same size or smaller, stays within budget.
function fitToBudget(page, maxTokens, meta, total) {
  const upper = {
    ...meta,
    truncated: { reason: 'limit', not_returned: total },
    est_tokens: 999999,
    next_offset: total,
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
// AtsError and library argument errors itself; this catches everything else.
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
  const _findAtsBySlug = deps.findAtsBySlug || findAtsBySlug;
  const _searchRegistry = deps.searchRegistry || searchRegistry;
  const _detectAts = deps.detectAts || libDetectAts;

  server.registerTool(
    'fetch_jobs',
    {
      title: 'Fetch jobs from a company ATS',
      description: FETCH_JOBS,
      annotations: { ...READ_ONLY, openWorldHint: true },
      outputSchema: envelopeSchema(z.array(JOB).nullable()),
      inputSchema: z.object({
        company: z.string().describe('Company slug or name (e.g. "stripe")'),
        title_filter: z.string().optional().describe('Regex matched against title only — role identity'),
        filter: z.string().optional().describe('Regex matched across title, department, description — topic/scope'),
        posted_within_days: z.number().int().positive().optional().describe('Only jobs posted within N days'),
        location_includes: z.array(z.string()).optional().describe('Keep jobs where any listed location contains any keyword'),
        location_excludes: z.array(z.string()).optional().describe('Drop jobs only when every listed location contains a keyword'),
        limit: z.number().int().positive().optional().describe('Max jobs per page (default 100). max_tokens usually stops output first.'),
        offset: z.number().int().min(0).optional().describe('Matches to skip after sorting (default 0). Pass next_offset from the previous response to get the next page.'),
        order: z.enum(['newest', 'board']).optional().describe('"newest" (default): by postedAt, undated last. "board": the ATS\'s own order.'),
        max_tokens: z.number().int().min(MIN_MAX_TOKENS).max(MAX_MAX_TOKENS).optional().describe(`Response budget in tokens, chars/4 of the text block (default ${DEFAULT_MAX_TOKENS}, ${MIN_MAX_TOKENS} to ${MAX_MAX_TOKENS}). Whole jobs only; at least one is always returned.`),
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
      let ats;
      let config;
      if (args.workday) {
        const { tenant, env, site } = args.workday;
        if (!tenant?.trim() || !env?.trim() || !site?.trim()) {
          return error(
            ERROR_CODES.INVALID_ARGS,
            'workday requires all three of {tenant, env, site}. Read them from the careers URL https://{tenant}.{env}.myworkdayjobs.com/{site}.'
          );
        }
        ats = 'workday';
        config = { tenant, env, site };
      }

      const limit = args.limit ?? DEFAULT_LIMIT;
      const offset = args.offset ?? 0;
      const order = args.order ?? 'newest';
      const maxTokens = args.max_tokens ?? DEFAULT_MAX_TOKENS;

      try {
        const { jobs: page, total_matched } = await _fetchJobsDetailed({
          company: args.company,
          ats,
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

        const normalizedSlug = args.company.toLowerCase().replace(/[^a-z0-9]/g, '');
        const registryAts = await _findAtsBySlug(normalizedSlug);

        // Discovery miss: not in the registry and no board returned anything.
        // Guard on !config so a valid Workday override that returns 0 jobs is not
        // mislabeled; a registry hit with 0 open roles stays a success([]).
        if (!config && registryAts === null && total_matched === 0) {
          return error(
            ERROR_CODES.COMPANY_NOT_FOUND,
            `No board found for "${args.company}" on any supported ATS. Check the slug, or pass an explicit workday {tenant,env,site} for a Workday board.`
          );
        }

        const meta = {
          count: 0,
          registry_hit: registryAts !== null,
          ats: config ? 'workday' : registryAts,
          workday_override: Boolean(config),
          version: VERSION,
          registry_source: getRegistrySource(),
          total_matched,
          truncated: null,
          offset,
          next_offset: null,
          order,
        };

        const jobs = fitToBudget(page, maxTokens, meta, total_matched);
        const notReturned = Math.max(0, total_matched - offset - jobs.length);
        let truncated = null;
        if (jobs.length < page.length) truncated = { reason: 'size', not_returned: notReturned };
        else if (notReturned > 0) truncated = { reason: 'limit', not_returned: notReturned };

        return successWithEstTokens(jobs, {
          ...meta,
          count: jobs.length,
          truncated,
          next_offset: notReturned > 0 ? offset + jobs.length : null,
        });
      } catch (err) {
        const msg = err.message || 'Unknown error';
        // AtsError carries a stable .code from the adapter (ats_unreachable /
        // rate_limited), so we map by code, not by parsing the message.
        if (err instanceof AtsError) {
          if (config && err.code === ERROR_CODES.ATS_UNREACHABLE) {
            // Keep the Workday triple-repair hint.
            return error(
              ERROR_CODES.ATS_UNREACHABLE,
              `Workday rejected ${config.tenant}/${config.env}/${config.site}: ${msg}. Verify the triple against the careers URL https://{tenant}.{env}.myworkdayjobs.com/{site}.`
            );
          }
          return error(err.code, msg);
        }
        // Anything else is an arg-validation error from the library.
        return error(ERROR_CODES.INVALID_ARGS, msg);
      }
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
        query: z.string().optional().describe('Substring match against company name'),
        sector: z.string().optional().describe('Match against sector (e.g. "fintech", "developer tools")'),
      }).strict(),
    },
    withEnvelope(async (args) => {
      if (!args.query && !args.sector) {
        return error(ERROR_CODES.INVALID_ARGS, 'Provide query or sector');
      }

      // searchRegistry searches both name and sector via a single query string.
      // We combine args into a single search string, preferring query if both given.
      const searchTerm = args.query || args.sector;
      const results = await _searchRegistry(searchTerm);

      // If sector was specified, further filter by sector match
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
      title: 'Detect which ATS a company uses',
      description: DETECT_ATS,
      annotations: { ...READ_ONLY, openWorldHint: true },
      outputSchema: envelopeSchema(z.string().nullable()),
      inputSchema: z.object({
        company: z.string().describe('Company name or slug'),
      }).strict(),
    },
    withEnvelope(async (args) => {
      const results = await _detectAts(args.company);

      if (results.length === 0) {
        return success(null, { attempted: ATS_NAMES, succeeded: [] });
      }

      if (results.length === 1) {
        return success(results[0].ats, {
          attempted: ATS_NAMES,
          succeeded: [results[0].ats],
        });
      }

      // Multiple matches — rare but possible if a company is registered on more than one ATS
      return partial(
        results[0].ats,
        {
          attempted: ATS_NAMES,
          succeeded: results.map((r) => r.ats),
          notes: [`Company found on multiple platforms: ${results.map((r) => r.ats).join(', ')}. Returning first match.`],
        }
      );
    })
  );
}
