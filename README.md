# ats-index

A structured index of who's hiring what, across every major ATS — with full descriptions, unified schema, and temporal diffs.

**Not a scraper. An index.** Every other ATS project gives you a snapshot. This gives you a timeline.

## What's different

- **Full job descriptions** — not just title + URL. Complete JDs converted to clean markdown.
- **Unified schema** — Greenhouse, Lever, Ashby all normalize to one format.
- **AI-ready** — structured for LLM consumption, embeddings pipelines, evaluation tools.
- **No browser required** — pure API calls. No Puppeteer, no Chrome, no cookies.
- **No auth** — all endpoints are public job board APIs.

## Quick start

```bash
npx ats-index fetch stripe
```

Or install:

```bash
npm install ats-index
```

## CLI

```bash
# Fetch all jobs from a company (auto-detects ATS platform)
ats-index fetch stripe

# Specify the ATS
ats-index fetch notion --ats ashby
ats-index fetch stripe --ats greenhouse

# Output as JSON
ats-index fetch linear --ats ashby --json

# Detect which ATS a company uses
ats-index detect figma

# Search the company registry
ats-index registry search fintech
```

## Library

```js
import { fetchJobs, registry } from 'ats-index';

// Fetch all jobs from a company
const jobs = await fetchJobs({ company: 'stripe' });

// Specify ATS platform
const jobs = await fetchJobs({ company: 'notion', ats: 'ashby' });

// Each job has the full schema:
// {
//   id, company, companySlug, ats,
//   title, department, location, locationType,
//   salary: { min, max, currency },
//   description,  // clean markdown, not HTML
//   url, postedAt, firstSeen, lastSeen, status,
//   metadata: { ... }
// }

// Search the registry
const fintechCompanies = await registry.search('fintech');

// Detect which ATS a company uses
const platforms = await registry.detect('stripe');
// [{ ats: 'greenhouse', slug: 'stripe' }]
```

## Supported platforms

| Platform | Adapter | Status |
|----------|---------|--------|
| Greenhouse | `greenhouse.js` | ✅ Full descriptions, departments, offices |
| Ashby | `ashby.js` | ✅ Full descriptions, compensation (when available) |
| Lever | `lever.js` | ✅ Full descriptions, departments, workplace type |
| BambooHR | — | Planned |
| Workday | — | Planned |

## Company registry

Ships with curated company slugs for popular tech companies. Community contributions welcome — submit a PR to add companies to `registry/*.json`.

```json
{"slug": "stripe", "name": "Stripe", "sector": "fintech"}
```

## Use cases

- **Job seekers** — pipe into evaluation tools, filter by role/location
- **Recruiters** — monitor competitor hiring patterns
- **Investors** — hiring velocity as growth/contraction signal
- **Researchers** — labor market datasets
- **Tool builders** — clean normalized API as foundation

## Roadmap

- [ ] SQLite storage for temporal diffs ("this role was posted 3 weeks ago")
- [ ] `ats-index diff stripe --since 7d` — what changed this week
- [ ] BambooHR and Workday adapters
- [ ] MCP server for AI tool integration
- [ ] Hiring signal computation (velocity, urgency, growth)
- [ ] JSONL export for embeddings pipelines

## License

MIT
