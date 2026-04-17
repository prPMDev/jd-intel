#!/usr/bin/env node

/**
 * ats-index CLI
 *
 * Usage:
 *   ats-index fetch <company> [--ats greenhouse|lever|ashby] [--filter keyword|pattern]
 *   ats-index detect <company>
 *   ats-index registry search <query>
 */

import { fetchJobs } from './index.js';
import { detectAts, searchRegistry } from './registry.js';

const [,, command, ...args] = process.argv;

async function main() {
  switch (command) {
    case 'fetch': {
      const company = args[0];
      if (!company) { console.error('Usage: ats-index fetch <company> [--ats greenhouse|lever|ashby]'); process.exit(1); }
      const getArg = (flag) => {
        const idx = args.indexOf(flag);
        return idx >= 0 ? args[idx + 1] : undefined;
      };
      const ats = getArg('--ats');
      const filter = getArg('--filter');
      const postedWithinRaw = getArg('--posted-within-days');
      const postedWithinDays = postedWithinRaw !== undefined ? Number(postedWithinRaw) : undefined;
      const locIncludeRaw = getArg('--location-include');
      const locationIncludes = locIncludeRaw ? locIncludeRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
      const locExcludeRaw = getArg('--location-exclude');
      const locationExcludes = locExcludeRaw ? locExcludeRaw.split(',').map(s => s.trim()).filter(Boolean) : undefined;
      const limitRaw = getArg('--limit');
      const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;

      const parts = [];
      if (filter) parts.push(`filter: ${filter}`);
      if (postedWithinDays !== undefined) parts.push(`within ${postedWithinDays}d`);
      if (locationIncludes) parts.push(`loc+: ${locationIncludes.join('|')}`);
      if (locationExcludes) parts.push(`loc-: ${locationExcludes.join('|')}`);
      const suffix = parts.length ? ` [${parts.join(', ')}]` : '';

      console.log(`Fetching jobs from ${company}${ats ? ` (${ats})` : ' (auto-detect)'}${suffix}...`);
      const jobs = await fetchJobs({
        company, ats, filter, postedWithinDays, locationIncludes, locationExcludes, limit,
      });
      console.log(`Found ${jobs.length} jobs\n`);

      for (const job of jobs.slice(0, 20)) {
        const salary = job.salary ? ` | $${job.salary.min?.toLocaleString()}-$${job.salary.max?.toLocaleString()}` : '';
        const loc = job.location ? ` | ${job.location}` : '';
        const dept = job.department ? ` [${job.department}]` : '';
        console.log(`  ${job.title}${dept}${loc}${salary}`);
        console.log(`  ${job.url}`);
        if (job.description) {
          const preview = job.description.substring(0, 120).replace(/\n/g, ' ');
          console.log(`  ${preview}...`);
        }
        console.log();
      }

      if (jobs.length > 20) {
        console.log(`  ... and ${jobs.length - 20} more. Use --json for full output.`);
      }

      if (args.includes('--json')) {
        console.log(JSON.stringify(jobs, null, 2));
      }
      break;
    }

    case 'detect': {
      const company = args[0];
      if (!company) { console.error('Usage: ats-index detect <company>'); process.exit(1); }
      console.log(`Detecting ATS for ${company}...`);
      const results = await detectAts(company);
      if (results.length === 0) {
        console.log('No ATS board found for this company.');
      } else {
        for (const r of results) {
          console.log(`  Found: ${r.ats} (slug: ${r.slug})`);
        }
      }
      break;
    }

    case 'registry': {
      const subcommand = args[0];
      if (subcommand === 'search') {
        const query = args.slice(1).join(' ');
        if (!query) { console.error('Usage: ats-index registry search <query>'); process.exit(1); }
        const results = await searchRegistry(query);
        console.log(`Found ${results.length} companies matching "${query}":\n`);
        for (const r of results) {
          console.log(`  ${r.name || r.slug} (${r.ats})${r.sector ? ` — ${r.sector}` : ''}`);
        }
      } else {
        console.error('Usage: ats-index registry search <query>');
      }
      break;
    }

    default:
      console.log(`ats-index — A structured index of who's hiring what.

Usage:
  ats-index fetch <company> [options]
  ats-index detect <company>
  ats-index registry search <query>

Fetch options:
  --ats greenhouse|lever|ashby    Skip auto-detect
  --filter pattern                Regex matched against title, department, description
  --posted-within-days N          Only jobs posted in the last N days
  --location-include "A,B,C"      Keep jobs whose location contains any of these
  --location-exclude "A,B,C"      Drop jobs whose location contains any of these
  --limit N                       Cap results (default 100)
  --json                          Output full JSON

Examples:
  ats-index fetch stripe
  ats-index fetch stripe --filter "product manager|PM" --posted-within-days 14
  ats-index fetch ramp --location-include "United States,US,Remote" --location-exclude "London,Dublin"
  ats-index fetch notion --ats ashby --filter integrations
  ats-index detect figma
  ats-index registry search fintech`);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
