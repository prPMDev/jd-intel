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
import { fetchJobs, detectAts as libDetectAts, registry, ATS_NAMES, AtsError } from 'jd-intel';

const { search: searchRegistry, findAtsBySlug } = registry;
// Tolerate an older jd-intel that predates getSource. The bundle always
// vendors a matching version; this only guards a skewed local/global install.
const getRegistrySource = registry.getSource || (() => 'unknown');
import { success, partial, error } from './envelope.js';
import { ERROR_CODES } from './errors.js';
import { VERSION } from './version.js';
import {
  FETCH_JOBS,
  SEARCH_REGISTRY,
  DETECT_ATS,
} from './descriptions.js';

export function registerTools(server, deps = {}) {
  const _fetchJobs = deps.fetchJobs || fetchJobs;
  const _findAtsBySlug = deps.findAtsBySlug || findAtsBySlug;

  server.registerTool(
    'fetch_jobs',
    {
      title: 'Fetch jobs from a company ATS',
      description: FETCH_JOBS,
      inputSchema: {
        company: z.string().describe('Company slug or name (e.g. "stripe")'),
        title_filter: z.string().optional().describe('Regex matched against title only — role identity'),
        filter: z.string().optional().describe('Regex matched across title, department, description — topic/scope'),
        posted_within_days: z.number().int().positive().optional().describe('Only jobs posted within N days'),
        location_includes: z.array(z.string()).optional().describe('Keep jobs whose location contains any keyword'),
        location_excludes: z.array(z.string()).optional().describe('Drop jobs whose location contains any keyword'),
        limit: z.number().int().positive().optional().describe('Cap results (default 100)'),
        workday: z
          .object({
            tenant: z.string().trim().min(1).describe('Workday tenant, the first URL label, e.g. "expedia"'),
            env: z.string().trim().min(1).describe('Workday env/datacenter, e.g. "wd108", "wd5"'),
            site: z.string().trim().min(1).describe('Workday career-site path, e.g. "search", "Cisco_Careers"'),
          })
          .strict()
          .optional()
          .describe('Override the registry for a Workday board not indexed. Derive all three from the careers URL https://{tenant}.{env}.myworkdayjobs.com/{site}. Never guess these.'),
      },
    },
    async (args) => {
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

      try {
        const jobs = await _fetchJobs({
          company: args.company,
          ats,
          config,
          titleFilter: args.title_filter,
          filter: args.filter,
          postedWithinDays: args.posted_within_days,
          locationIncludes: args.location_includes,
          locationExcludes: args.location_excludes,
          limit: args.limit,
        });

        const normalizedSlug = args.company.toLowerCase().replace(/[^a-z0-9]/g, '');
        const registryAts = await _findAtsBySlug(normalizedSlug);

        // Discovery miss: not in the registry and no board returned anything.
        // Guard on !config so a valid Workday override that returns 0 jobs is not
        // mislabeled; a registry hit with 0 open roles stays a success([]).
        if (!config && registryAts === null && jobs.length === 0) {
          return error(
            ERROR_CODES.COMPANY_NOT_FOUND,
            `No board found for "${args.company}" on any supported ATS. Check the slug, or pass an explicit workday {tenant,env,site} for a Workday board.`
          );
        }

        return success(jobs, {
          count: jobs.length,
          registry_hit: registryAts !== null,
          ats: config ? 'workday' : registryAts,
          workday_override: Boolean(config),
          version: VERSION,
          registry_source: getRegistrySource(),
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
    }
  );

  server.registerTool(
    'search_registry',
    {
      title: 'Search the company registry',
      description: SEARCH_REGISTRY,
      inputSchema: {
        query: z.string().optional().describe('Substring match against company name'),
        sector: z.string().optional().describe('Match against sector (e.g. "fintech", "developer tools")'),
      },
    },
    async (args) => {
      if (!args.query && !args.sector) {
        return error(ERROR_CODES.INVALID_ARGS, 'Provide query or sector');
      }

      // searchRegistry searches both name and sector via a single query string.
      // We combine args into a single search string, preferring query if both given.
      const searchTerm = args.query || args.sector;
      const results = await searchRegistry(searchTerm);

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
    }
  );

  server.registerTool(
    'detect_ats',
    {
      title: 'Detect which ATS a company uses',
      description: DETECT_ATS,
      inputSchema: {
        company: z.string().describe('Company name or slug'),
      },
    },
    async (args) => {
      const results = await libDetectAts(args.company);

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
    }
  );
}
