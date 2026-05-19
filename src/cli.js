#!/usr/bin/env node

/**
 * jd-intel CLI
 *
 * Usage:
 *   jd-intel fetch <company> [--ats <platform>] [--filter keyword|pattern]
 *   jd-intel detect <company>
 *   jd-intel registry search <query>
 */

import { fetchJobs } from './index.js';
import { detectAts, searchRegistry } from './registry.js';

const [,, command, ...args] = process.argv;

async function main() {
  switch (command) {
    case 'fetch': {
      const company = args[0];
      if (!company) { console.error('Usage: jd-intel fetch <company> [--ats <platform>]  (omit --ats to auto-detect; run "jd-intel" for the platform list)'); process.exit(1); }
      const getArg = (flag) => {
        const idx = args.indexOf(flag);
        return idx >= 0 ? args[idx + 1] : undefined;
      };
      let ats = getArg('--ats');
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

      // Workday is keyed by a {tenant, env, site} triple, not a slug.
      // Supplying it here makes a Workday board reachable without a
      // registry entry; presence of the flags infers --ats workday.
      const wdTenant = getArg('--workday-tenant');
      const wdEnv = getArg('--workday-env');
      const wdSite = getArg('--workday-site');
      let config;
      if (wdTenant || wdEnv || wdSite) {
        if (!wdTenant || !wdEnv || !wdSite) {
          console.error('Workday needs all three: --workday-tenant, --workday-env, --workday-site.');
          console.error('Find them in the careers URL: https://{tenant}.{env}.myworkdayjobs.com/{site}');
          console.error('e.g. https://expedia.wd108.myworkdayjobs.com/search  ->  --workday-tenant expedia --workday-env wd108 --workday-site search');
          process.exit(1);
        }
        if (ats && ats !== 'workday') {
          console.error(`--ats ${ats} conflicts with the --workday-* flags (workday is inferred). Drop one.`);
          process.exit(1);
        }
        config = { tenant: wdTenant, env: wdEnv, site: wdSite };
        ats = 'workday';
      }

      const parts = [];
      if (titleFilter) parts.push(`title: ${titleFilter}`);
      if (filter) parts.push(`topic: ${filter}`);
      if (postedWithinDays !== undefined) parts.push(`within ${postedWithinDays}d`);
      if (locationIncludes) parts.push(`loc+: ${locationIncludes.join('|')}`);
      if (locationExcludes) parts.push(`loc-: ${locationExcludes.join('|')}`);
      const suffix = parts.length ? ` [${parts.join(', ')}]` : '';

      const atsLabel = config
        ? ` (workday: ${config.tenant}/${config.env}/${config.site})`
        : ats ? ` (${ats})` : ' (auto-detect)';
      console.log(`Fetching jobs from ${company}${atsLabel}${suffix}...`);
      let jobs;
      try {
        jobs = await fetchJobs({
          company, ats, config, titleFilter, filter, postedWithinDays, locationIncludes, locationExcludes, limit,
        });
      } catch (err) {
        if (config) {
          console.error(`Could not reach that Workday board (${config.tenant}/${config.env}/${config.site}): ${err.message}`);
          console.error('Verify the triple against the careers URL: https://{tenant}.{env}.myworkdayjobs.com/{site}');
          process.exit(1);
        }
        throw err;
      }
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
      if (!company) { console.error('Usage: jd-intel detect <company>'); process.exit(1); }
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
        if (!query) { console.error('Usage: jd-intel registry search <query>'); process.exit(1); }
        const results = await searchRegistry(query);
        console.log(`Found ${results.length} companies matching "${query}":\n`);
        for (const r of results) {
          console.log(`  ${r.name || r.slug} (${r.ats})${r.sector ? ` — ${r.sector}` : ''}`);
        }
      } else {
        console.error('Usage: jd-intel registry search <query>');
      }
      break;
    }

    default:
      console.log(`jd-intel — JD intelligence toolkit for your AI assistant.

Usage:
  jd-intel fetch <company> [options]
  jd-intel detect <company>
  jd-intel registry search <query>

Fetch options:
  --ats <platform>                Skip auto-detect. One of: greenhouse, lever,
                                  ashby, smartrecruiters, teamtailor, recruitee,
                                  workday. Omit to auto-detect (registry-backed).
  --workday-tenant T              Workday is keyed by a {tenant, env, site}
  --workday-env wdN               triple, not a slug. Registered Workday
  --workday-site S                companies work via auto-detect or --ats
                                  workday; for any other Workday board pass
                                  all three, read from the careers URL
                                  https://{tenant}.{env}.myworkdayjobs.com/{site}
                                  e.g. https://expedia.wd108.myworkdayjobs.com/search
                                  -> --workday-tenant expedia --workday-env wd108
                                     --workday-site search
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
  jd-intel fetch stripe
  jd-intel fetch stripe --title-filter "product manager" --filter "growth|platform"
  jd-intel fetch ramp --location-include "United States,US,Remote - US" --location-exclude "London,Dublin"
  jd-intel fetch notion --ats ashby --title-filter engineer --posted-within-days 14
  jd-intel fetch expedia --workday-tenant expedia --workday-env wd108 --workday-site search
  jd-intel detect figma
  jd-intel registry search fintech`);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
