#!/usr/bin/env node

/**
 * jd-intel CLI
 *
 * Usage:
 *   jd-intel fetch <company> [--ats <platform>] [--filter keyword|pattern]
 *   jd-intel detect <company>
 *   jd-intel registry search <query>
 */

import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fetchJobs } from './index.js';
import { detectAtsDetailed, searchRegistry } from './registry.js';

const [,, command, ...args] = process.argv;

async function main() {
  switch (command) {
    case 'fetch': {
      const string = { type: 'string' };
      const { values: flags, positionals } = parseArgs({
        args,
        allowPositionals: true,
        options: {
          ats: string, 'title-filter': string, filter: string, 'posted-within-days': string,
          'location-include': string, 'location-exclude': string, limit: string,
          'workday-tenant': string, 'workday-env': string, 'workday-site': string,
          json: { type: 'boolean' },
        },
      });
      const company = positionals[0];
      if (!company) { console.error('Usage: jd-intel fetch <company> [--ats <platform>]  (omit --ats to auto-detect; run "jd-intel" for the platform list)'); process.exit(1); }
      const number = (v) => (v !== undefined ? Number(v) : undefined);
      const list = (v) => (v ? v.split(',').map(s => s.trim()).filter(Boolean) : undefined);
      let ats = flags.ats;
      const titleFilter = flags['title-filter'];
      const filter = flags.filter;
      const postedWithinDays = number(flags['posted-within-days']);
      const locationIncludes = list(flags['location-include']);
      const locationExcludes = list(flags['location-exclude']);
      const limit = number(flags.limit);

      // Workday is keyed by a {tenant, env, site} triple, not a slug.
      // Supplying it here makes a Workday board reachable without a
      // registry entry; presence of the flags infers --ats workday.
      const wdTenant = flags['workday-tenant'];
      const wdEnv = flags['workday-env'];
      const wdSite = flags['workday-site'];
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
        const salary = job.salary ? ` | ${formatSalary(job.salary)}` : '';
        const loc = job.location ? ` | ${job.location}` : '';
        const dept = job.department ? ` [${job.department}]` : '';
        console.log(`  ${job.title}${dept}${loc}${salary}`);
        console.log(`  ${job.url || '(no URL: posting not read)'}`);
        if (job.content?.status === 'missing') {
          console.log(`  posting not read: ${job.content.reason}`);
        } else if (job.description) {
          const preview = job.description.substring(0, 120).replace(/\n/g, ' ');
          console.log(`  ${preview}...`);
        }
        console.log();
      }

      if (jobs.length > 20) {
        console.log(`  ... and ${jobs.length - 20} more. Use --json for full output.`);
      }

      if (flags.json) {
        console.log(JSON.stringify(jobs, null, 2));
      }
      break;
    }

    case 'detect': {
      const company = args[0];
      if (!company) { console.error('Usage: jd-intel detect <company>'); process.exit(1); }
      console.log(`Detecting ATS for ${company}...`);
      const { boards, failed } = await detectAtsDetailed(company);
      for (const b of boards) {
        console.log(`  Found: ${b.ats} (slug: ${b.slug}, ${b.source === 'registry' ? 'in the registry' : 'live probe'})`);
      }
      for (const f of failed) {
        console.log(`  Could not check ${f.ats}: ${f.message}`);
      }
      if (boards.length === 0) {
        console.log(failed.length > 0
          ? 'No ATS board confirmed. At least one check failed, so this is not a definite miss. Retry in a moment.'
          : 'No ATS board found for this company.');
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
  --location-include "A,B,C"      Keep jobs where any listed location contains one of these
  --location-exclude "A,B,C"      Drop jobs only when every listed location contains one of these
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

export function formatSalary({ min, max, currency, period }) {
  const hasMin = min != null;
  const hasMax = max != null;
  let range;
  if (hasMin && hasMax) range = `${min.toLocaleString()}-${max.toLocaleString()}`;
  else if (hasMin) range = `from ${min.toLocaleString()}`;
  else range = `up to ${max.toLocaleString()}`;
  const unit = period === 'hour' ? '/hr' : period === 'month' ? '/mo' : '';
  return `${range} ${currency}${unit}`;
}

// Boot only when this file is the script Node was started with, so a test
// can import formatSalary without running a command. argv[1] is resolved
// through realpath because npm installs the bin as a symlink into .bin/,
// while import.meta.url already points at the real file.
function isEntrypoint() {
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
