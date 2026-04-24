# jd-intel

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/node-18%2B-green.svg)](https://nodejs.org)

> **Stop pasting job descriptions into ChatGPT. Your AI assistant can fetch them directly — full text, salary ranges, across every major ATS.**

---

## What this is

jd-intel is a toolkit for making job descriptions AI-accessible. It contains three things:

- **A library** (`jd-intel`) — fetch and normalize jobs across Greenhouse, Lever, and Ashby with one API
- **A CLI** (`npx jd-intel fetch <company>`) — same capabilities from the command line
- **An MCP server** (`jd-intel-mcp`) — lets any AI assistant (Claude Desktop, Cursor, Windsurf) query jobs through natural conversation

Same core data. Three surfaces. Pick the one that fits how you work.

## Why this exists

Every career advice thread tells you to paste job descriptions into ChatGPT for tailored cover letters, fit analysis, resume rewrites. But across 20 applications, copy-pasting 20 JDs is a part-time job — and half the formatting breaks, salary info gets lost, links die.

Every company's careers page sits behind a different ATS (Greenhouse, Lever, Ashby, more). Getting structured data means writing custom integrations for each. Most tools settle for titles and links with no descriptions.

jd-intel gives your AI one unified way to reach them. Public data, public APIs, no scraping, no copy-paste.

## Try it

**From the command line:**

```bash
npx jd-intel fetch stripe --title-filter "product manager" --posted-within-days 14
```

Returns every PM role posted at Stripe in the last two weeks — title, department, location, salary, full description, direct link.

**Or from your AI assistant (via the MCP server):**

> "Find me product manager roles at Stripe, remote US only, and draft a cover letter for the top match based on my resume."

Claude fetches the JDs directly, reads them, and drafts. No copy-paste.

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
npx jd-intel fetch ramp --title-filter "product manager" --location-include "United States,Remote - US" --posted-within-days 7
```

**Sector sweep**
```bash
npx jd-intel registry search fintech
```

**Plug it into your AI workflow**
```js
import { fetchJobs, registry } from 'jd-intel';

const jobs = await fetchJobs({
  company: 'ramp',
  titleFilter: 'engineer',
  postedWithinDays: 14,
  limit: 50,
});
```

Job seekers use it for daily shortlists and AI-drafted cover letters. Tool builders use it as a foundation for AI agents. Researchers use it for hiring-trend analysis.

## Install

**As a CLI or library:**
```bash
npm install jd-intel
# or use without installing
npx jd-intel fetch <company-slug>
```

**As an MCP server in Claude Desktop:**
See [mcp/README.md](mcp/README.md) for the config snippet. One-command install planned: `npx jd-intel-mcp install`.

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

All filters AND together. Deep dive: [docs/filters.md](docs/filters.md).

## Roadmap

**Shipped**
- Library, CLI, and MCP server
- Greenhouse, Ashby, Lever adapters
- Title / topic / location / date filters
- Salary extraction
- Verified company registry (66 companies)

**In progress**
- Publish `jd-intel-mcp` to npm
- Anthropic MCP marketplace submission
- Non-tech-friendly setup guide with screenshots

**Planned**
- BambooHR and Workday adapters
- Temporal tracking (when roles open, close, reopen)
- Change detection
- Remote MCP transport (Claude.ai Custom Connector support)

## Contributing

**Add a company to the registry:** submit a PR to the appropriate file in `registry/`.

**Add an ATS adapter:** new file in `src/adapters/`, follow the pattern of existing adapters.

## Built by

**[Prashant R](https://prashantrana.xyz)** — PM who builds. I write about AI, product work, and the integration layer — where APIs, agents, and products fit together in practice.

- Portfolio + writing: [prashantrana.xyz](https://prashantrana.xyz)
- [LinkedIn](https://www.linkedin.com/in/prashant-rana)

jd-intel is one experiment at that intersection.

## License

MIT
