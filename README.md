# ats-index

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/node-18%2B-green.svg)](https://nodejs.org)

> **One API to search jobs across every ATS. Full descriptions, salary ranges, 66 verified companies — no API keys, no scraping.**

---

## Why this exists

Every company's careers page sits behind a different ATS — Greenhouse, Lever, Ashby, and more. Getting structured data means writing custom integrations for each one, parsing different response formats, and usually settling for job titles and links with no descriptions.

ats-index gives you one unified API to all of them. Public data, public APIs, no scraping — just the integration work you'd rather not redo.

## Try it

```bash
npx ats-index fetch stripe --title-filter "product manager" --posted-within-days 14
```

Returns every PM role posted at Stripe in the last two weeks — title, department, location, salary, full description, direct link.

## What you get back

Every job normalizes to this shape, across every platform:

```json
{
  "id": "a1b2c3d4e5f6",
  "company": "Stripe",
  "title": "Senior Product Manager, Integrations",
  "department": "Product",
  "location": "San Francisco, CA",
  "locationType": "hybrid",
  "salary": { "min": 180000, "max": 260000, "currency": "USD" },
  "description": "Lead strategy for Stripe's integration ecosystem...",
  "url": "https://boards.greenhouse.io/stripe/jobs/12345",
  "postedAt": "2026-04-10T14:30:00Z"
}
```

No custom parsing per company. One schema across Greenhouse, Ashby, and Lever.

## What you can build with it

**Daily scan at target companies**
```bash
npx ats-index fetch ramp --title-filter "product manager" --location-include "United States,Remote - US" --posted-within-days 7
```

**Sector sweep**
```bash
npx ats-index registry search fintech
# Loop fetch_jobs over each slug to scan a whole segment
```

**As a library for your own tools**
```js
import { fetchJobs, registry } from 'ats-index';

const jobs = await fetchJobs({
  company: 'ramp',
  titleFilter: 'engineer',
  postedWithinDays: 14,
  limit: 50,
});
```

Job seekers use it for daily shortlists. Tool builders use it as a foundation for AI agents and career platforms. Researchers use it for hiring-trend analysis.

## Install

```bash
npm install ats-index
```

Or run without installing:

```bash
npx ats-index fetch <company-slug>
```

Node.js 18+. No API keys. No configuration.

## Data model

| Field | Description |
|-------|-------------|
| `title` | Full job title |
| `company` | Normalized company name |
| `department` | Team or department (when provided) |
| `location` | City, state, country, or remote |
| `locationType` | `remote` / `hybrid` / `onsite` |
| `salary` | Min-max range with currency (when available) |
| `description` | Full JD in clean markdown |
| `url` | Direct link to the posting |
| `postedAt` | Publication date (when provided) |

## Platforms

| Platform | Status | Typical use |
|----------|--------|-------------|
| Greenhouse | Shipped | Most widely used ATS in tech |
| Ashby | Shipped | Growing fast with startups |
| Lever | Shipped | Common at mid-stage companies |
| BambooHR | Planned | Mid-market companies |
| Workday | Planned | Large enterprises |

Adding a new ATS is a single adapter file. See [Contributing](#contributing).

## Filters (quick reference)

| Flag | What it matches | Use for |
|------|-----------------|---------|
| `--title-filter` | Title only | Role identity (PM, engineer, designer) |
| `--filter` | Title + department + description | Topic / scope (integrations, growth) |
| `--posted-within-days` | Recent postings | Recency cuts |
| `--location-include` | Location contains any keyword | Region targeting |
| `--location-exclude` | Location contains no keyword | Drop geographic noise |
| `--limit` | First N results | Cap output size |

All filters AND together. Deep dive on filter design patterns: [docs/filters.md](docs/filters.md).

## Roadmap

**Shipped**
- Greenhouse, Ashby, Lever adapters
- Title / topic / location / date filters
- Salary extraction
- Verified company registry (66 companies)

**In progress**
- MCP server — expose as a tool for AI assistants (Claude Desktop, Cursor, etc.)

**Planned**
- BambooHR and Workday adapters
- Temporal tracking (when roles open, close, reopen)
- Change detection

## Contributing

**Add a company to the registry:** submit a PR to the appropriate file in `registry/`.

**Add an ATS adapter:** new file in `src/adapters/`, follow the pattern of existing adapters.

## Built by

**[Prashant R](https://prashantrana.xyz)** — PM who builds. I write about AI, product work, and the integration layer — where APIs, agents, and products fit together in practice.

- Portfolio + writing: [prashantrana.xyz](https://prashantrana.xyz)
- [LinkedIn](https://www.linkedin.com/in/prashant-rana)

ats-index is one experiment at that intersection. An MCP server version is coming next — turns this into a tool any AI assistant can use.

## License

MIT
