#!/usr/bin/env node

/**
 * ats-index CLI
 *
 * Usage:
 *   ats-index fetch <company> [--ats greenhouse|lever|ashby]
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
      const atsIdx = args.indexOf('--ats');
      const ats = atsIdx >= 0 ? args[atsIdx + 1] : undefined;

      console.log(`Fetching jobs from ${company}${ats ? ` (${ats})` : ' (auto-detect)'}...`);
      const jobs = await fetchJobs({ company, ats });
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
  ats-index fetch <company> [--ats greenhouse|lever|ashby] [--json]
  ats-index detect <company>
  ats-index registry search <query>

Examples:
  ats-index fetch stripe
  ats-index fetch notion --ats ashby
  ats-index detect figma
  ats-index registry search fintech`);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
