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
      const titleFilter = getArg('--title-filter');
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
      if (titleFilter) parts.push(`title: ${titleFilter}`);
      if (filter) parts.push(`topic: ${filter}`);
      if (postedWithinDays !== undefined) parts.push(`within ${postedWithinDays}d`);
      if (locationIncludes) parts.push(`loc+: ${locationIncludes.join('|')}`);
      if (locationExcludes) parts.push(`loc-: ${locationExcludes.join('|')}`);
      const suffix = parts.length ? ` [${parts.join(', ')}]` : '';

      console.log(`Fetching jobs from ${company}${ats ? ` (${ats})` : ' (auto-detect)'}${suffix}...`);
      const jobs = await fetchJobs({
        company, ats, titleFilter, filter, postedWithinDays, locationIncludes, locationExcludes, limit,
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
  --title-filter pattern          Regex matched against TITLE only (role identity)
  --filter pattern                Regex matched across title, department, description (topic/scope)
  --posted-within-days N          Only jobs posted in the last N days
  --location-include "A,B,C"      Keep jobs whose location contains any of these
  --location-exclude "A,B,C"      Drop jobs whose location contains any of these
  --limit N                       Cap results (default 100)
  --json                          Output full JSON

Filter guidance:
  Use --title-filter for "what KIND of role" (PM, engineer, designer).
  Use --filter for "what it's ABOUT" (integrations, growth, payments).
  Both AND together. Avoid --filter "product manager" — description
  mentions of PMs in other roles' JDs create false positives.

Examples:
  ats-index fetch stripe
  ats-index fetch stripe --title-filter "product manager" --filter "growth|platform"
  ats-index fetch ramp --location-include "United States,US,Remote - US" --location-exclude "London,Dublin"
  ats-index fetch notion --ats ashby --title-filter engineer --posted-within-days 14
  ats-index detect figma
  ats-index registry search fintech`);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
