/**
 * Register all three tools on the MCP server.
 *
 * Each handler:
 *   1. Validates args (Zod handles most of this)
 *   2. Calls the ats-index library
 *   3. Wraps the result in the uniform envelope
 *
 * Handlers stay thin — library does the work, MCP layer shapes the response.
 */

import { z } from 'zod';
import { fetchJobs, detectAts as libDetectAts } from '../src/index.js';
import { searchRegistry, findAtsBySlug } from '../src/registry.js';
import { success, partial, error } from './envelope.js';
import { ERROR_CODES } from './errors.js';
import {
  FETCH_JOBS,
  SEARCH_REGISTRY,
  DETECT_ATS,
} from './descriptions.js';

export function registerTools(server) {
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
      },
    },
    async (args) => {
      try {
        const jobs = await fetchJobs({
          company: args.company,
          titleFilter: args.title_filter,
          filter: args.filter,
          postedWithinDays: args.posted_within_days,
          locationIncludes: args.location_includes,
          locationExcludes: args.location_excludes,
          limit: args.limit,
        });

        const normalizedSlug = args.company.toLowerCase().replace(/[^a-z0-9]/g, '');
        const registryAts = await findAtsBySlug(normalizedSlug);

        return success(jobs, {
          count: jobs.length,
          registry_hit: registryAts !== null,
          ats: registryAts,
        });
      } catch (err) {
        return error(ERROR_CODES.INVALID_ARGS, err.message || 'Unknown error');
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
        return success(null, { attempted: ['greenhouse', 'lever', 'ashby'], succeeded: [] });
      }

      if (results.length === 1) {
        return success(results[0].ats, {
          attempted: ['greenhouse', 'lever', 'ashby'],
          succeeded: [results[0].ats],
        });
      }

      // Multiple matches — rare but possible if a company is registered on more than one ATS
      return partial(
        results[0].ats,
        {
          attempted: ['greenhouse', 'lever', 'ashby'],
          succeeded: results.map((r) => r.ats),
          notes: [`Company found on multiple platforms: ${results.map((r) => r.ats).join(', ')}. Returning first match.`],
        }
      );
    }
  );
}
