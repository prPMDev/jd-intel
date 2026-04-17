# ats-index

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/node-18%2B-green.svg)](https://nodejs.org)

**One API to search job listings across ATS platforms: full descriptions, not just titles.**

---

## Problem statement

Job seekers, developers, and researchers need structured job listing data from company career pages. Today, getting this data requires:

- Knowing which ATS platform each company uses
- Writing custom API integrations for each platform
- Parsing different response formats across platforms
- Getting only titles and links from most existing tools, with no job descriptions

There is no single, open-source way to query multiple ATS platforms and get complete, normalized job data back.

## Solution

ats-index provides a unified interface to fetch job listings across ATS platforms. One call returns structured data with full job descriptions in clean markdown, regardless of which platform the company uses. Starting with the most common platforms in tech, with more adapters being added.

```bash
npx ats-index fetch <company-slug>
```

The system auto-detects which ATS a company uses, fetches all open roles, normalizes the response into a common schema, and converts HTML job descriptions into readable markdown.

No API keys. No browser automation. No scraping. Just public API calls.

---

## Target users

| Segment | Need | How ats-index helps |
|---------|------|-------------------|
| **Job seekers** | Search company career pages without visiting each one | Fetch and filter roles across companies from the command line or through an AI assistant |
| **Tool builders** | Structured job data as a foundation for career platforms, AI agents, or evaluation tools | Import as an npm library. Unified schema, no adapter code needed. |
| **Researchers** | Hiring trend data across the tech industry | Structured, queryable data from thousands of company job boards |

---

## Data model

Every job listing is normalized into a consistent schema:

| Field | Description | Availability |
|-------|-------------|-------------|
| **title** | Full job title with team or department context | Always |
| **company** | Normalized company name | Always |
| **department** | Team or department name | When provided by ATS |
| **location** | City, state, country | Always |
| **locationType** | remote / hybrid / onsite | Derived from location text |
| **salary** | Min-max range with currency | Extracted from structured fields or JD text |
| **description** | Complete job description in clean markdown | Always |
| **url** | Direct link to the job posting | Always |
| **postedAt** | Publication date | When provided by ATS |

---

## Platform coverage

| Platform | Market position | API type | Key data points |
|----------|----------------|----------|----------------|
| **Greenhouse** | Most widely used ATS in tech | REST (public, no auth) | Full JDs, departments, offices |
| **Ashby** | Growing fast with startups | REST + GraphQL (public, no auth) | Full JDs, compensation data, employment type |
| **Lever** | Common in mid-stage companies | REST (public, no auth) | Full JDs, departments, workplace type |
| **BambooHR** | Next | Public careers API | Mid-market companies |
| **Workday** | Next | Paginated POST API | Large enterprises |
| **iCIMS** | Planned | Sitemap-based | Enterprise ATS |

Adding a new ATS adapter is a single file. The architecture is designed to grow.

---

## How it works

### Command line

```bash
# Fetch all open roles at a company (auto-detects platform)
ats-index fetch <company-slug>

# Specify the platform explicitly
ats-index fetch <company-slug> --ats greenhouse

# Role-type gate (matches title only — reliable role identity)
ats-index fetch stripe --title-filter "product manager"

# Topic/scope match (title + department + description)
ats-index fetch stripe --filter "integrations|partnerships"

# Combined: PM roles about integrations (title gate AND topic match)
ats-index fetch stripe --title-filter "product manager" --filter "integrations|partnerships"

# Only recent roles
ats-index fetch stripe --posted-within-days 14

# Cut geographic noise (comma-separated keyword lists)
ats-index fetch ramp --location-include "United States,US,Remote - US" --location-exclude "London,Dublin,Berlin"

# Detect which ATS a company uses
ats-index detect <company-name>

# Search the built-in company registry by sector
ats-index registry search fintech

# JSON output for piping into other tools
ats-index fetch <company-slug> --json
```

### As a library

```js
import { fetchJobs, registry } from 'ats-index';

const jobs = await fetchJobs({
  company: 'ramp',
  titleFilter: 'product manager',         // role identity (title only)
  filter: 'integrations|partnerships',    // topic/scope (anywhere)
  postedWithinDays: 14,
  locationIncludes: ['United States', 'US', 'Remote - US'],
  locationExcludes: ['London', 'Dublin'],
  limit: 50,
});

const companies = await registry.search('fintech');
const platforms = await registry.detect('company-name');
```

### Filter design

Filters operate on structured fields only — deterministic, fast, no interpretation. For semantic cuts ("is this role senior enough", "is it truly remote-friendly"), let the AI layer reason over the returned jobs.

| Filter | Matches | Use when |
|--------|---------|----------|
| `titleFilter` | **Title only** | Role identity — "what KIND of role" ("PM", "Staff Engineer") |
| `filter` | Title + department + description | Topic/scope — "what it's ABOUT" ("integrations", "growth") |
| `postedWithinDays` | `postedAt` within N days | Recency cuts |
| `locationIncludes` | Any keyword matches location (OR) | Region targeting |
| `locationExcludes` | No keyword matches location | Drop geographic noise (EMEA pollution) |
| `limit` | First N results | Cap output size |

**Why title and topic are separate flags:**

`--filter "product manager"` alone creates false positives — engineering JDs that mention "the product manager" as a collaborator get swept in. The keyword means different things in different fields:

- In a **title**, "product manager" means *this role IS a PM*
- In a **description**, "product manager" often means *this role works with PMs*

Split intent:
- `--title-filter "product manager"` — role identity (title must match)
- `--filter "integrations"` — topic scope (matches anywhere)

Both AND together. One CLI call captures "PM roles about integrations" with no noise.

**Location filtering notes:**

- **Prefer include over exclude.** Excluding every non-US location requires enumerating the world. `--location-include "United States,US,Remote - US"` is bounded and cleaner.
- **Avoid bare "Remote"** as an inclusion — it matches "Remote (LatAm)", "Remote (EMEA)", "Remote - Global". Prefer qualified terms like "Remote - US" or pair "Remote" with country keywords.
- Use exclude as a refinement on top of include, not as the primary tool.

---

## Architecture

```
CLI / Library API
      |
      v
  Auto-detect (checks each ATS for the company slug)
      |
      v
  ATS Adapter (one per platform: greenhouse.js, ashby.js, lever.js)
      |
      v
  Normalizer (maps platform-specific response to unified schema, strips HTML to markdown)
      |
      v
  Structured output (JSON, or formatted CLI display)
```

Each adapter is a single file. Adding a new ATS platform means adding one adapter and registering it.

---

## Company registry

Ships with a curated registry of tech companies organized by ATS platform and sector. The registry enables:

- Auto-detection of which ATS a company uses
- Sector-based search ("show me all fintech companies")
- Community contributions via PR

Format:
```json
{"slug": "company-slug", "name": "Company Name", "sector": "industry"}
```

---

## Roadmap

| Feature | Status | Description |
|---------|--------|-------------|
| Greenhouse adapter | Shipped | Full JDs, departments, offices |
| Ashby adapter | Shipped | Full JDs, compensation, employment type |
| Lever adapter | Shipped | Full JDs, departments, workplace type |
| Auto-detect | Shipped | Checks all platforms for a company slug |
| Company registry | Shipped | 36 verified companies across platforms |
| Title filter (role identity) | Shipped | --title-filter for role-type gating (title only) |
| Topic filter (scope) | Shipped | --filter for topic match across title, department, description |
| Posted-within filter | Shipped | --posted-within-days for recency cuts |
| Location filters | Shipped | --location-include / --location-exclude for geographic targeting |
| Salary extraction | Shipped | From structured fields and JD text |
| Temporal tracking | Planned | Track when roles open, close, or reopen |
| Change detection | Planned | Surface what changed since your last check |
| BambooHR adapter | Planned | Expand platform coverage |
| Workday adapter | Planned | Expand platform coverage |
| MCP server | Planned | Expose as a tool for AI assistants |

---

## Install

```bash
npm install ats-index
```

Or run without installing:

```bash
npx ats-index fetch <company-slug>
```

**Requirements:** Node.js 18+. No API keys needed.

---

## Contributing

Adding a company to the registry: submit a PR to the JSON files in `registry/`.

Adding a new ATS adapter: create a new file in `src/adapters/` following the pattern of existing adapters. Each adapter exports a `fetch` function that takes a company slug and returns normalized job objects.

---

## License

MIT
