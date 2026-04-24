# jd-intel

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/node-18%2B-green.svg)](https://nodejs.org)
[![npm](https://img.shields.io/npm/v/jd-intel.svg)](https://www.npmjs.com/package/jd-intel)

> **Stop pasting job descriptions into AI assistants. Let your AI fetch them directly.**

Full text. Clean structure. Across every major ATS. No copy-paste. No context loss.

---

## Why this exists

Your AI assistant already knows a lot about you. Your resume is in its memory. Your target roles, your past projects, your background. Ready to help the moment you feed it a job description.

So you copy-paste.

A JD from Stripe. Another from Mercury. Six more from your target list. Half have broken HTML. Salary info dies in translation. Links get stripped. And for every role, the dance starts over.

You could wait for the job boards to ship their own MCPs. They'll get there eventually. On their timeline. Filtered through their priorities, not yours. Tied to their query abstractions.

jd-intel skips that wait. Raw JDs, fetched directly by your AI, on your terms. One level below the curated layer.

> "Claude, pull the senior PM role at Stripe and draft a cover letter based on my resume."

Done.

---

## What you can do with it

- Draft cover letters without pasting anything
- Tailor your resume across ten roles in one conversation
- Rank openings by fit with your background
- Scan a whole sector: "Pull PM roles at fintech companies posted this week"
- Research teams by reading their JDs in bulk

The toolkit fetches. Your AI thinks.

---

## Install

### For Claude Desktop, Cursor, Windsurf users

Add to your MCP config file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "jd-intel": {
      "command": "npx",
      "args": ["-y", "jd-intel-mcp"]
    }
  }
}
```

Restart your AI client. The tools appear automatically. Ask your AI to fetch any role.

**One-command install (avoids hand-editing the config):**
```bash
npx jd-intel-mcp install
```

### For developers (CLI and library)

```bash
npm install jd-intel
```

Or run without installing:

```bash
npx jd-intel fetch stripe --title-filter "product manager"
```

Or import as a library:

```js
import { fetchJobs, registry } from 'jd-intel';

const jobs = await fetchJobs({
  company: 'ramp',
  titleFilter: 'engineer',
  postedWithinDays: 14,
  limit: 50,
});
```

Node.js 18+. No API keys. No configuration.

---

## MCP tools

| Tool | Purpose |
|------|---------|
| `fetch_jobs` | Get open roles at a company with filters for role type, topic, location, and recency |
| `search_registry` | Find companies by name or sector |
| `detect_ats` | Identify which ATS platform a company uses |

Plus one Resource: `registry://jd-intel/all`. Full company registry, grouped by ATS. Fetched lazily for broad catalog surveys.

---

## What you get back

Every job normalizes to one schema, across every platform:

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

No custom parsing per company.

### Data model

| Field | Description |
|-------|-------------|
| `title` | Full job title |
| `company` | Normalized company name |
| `department` | Team or department (when provided) |
| `location` | City, state, country, or remote |
| `locationType` | `remote`, `hybrid`, or `onsite` |
| `salary` | Min-max range with currency (when available) |
| `description` | Full JD in clean markdown |
| `url` | Direct link to the posting |
| `postedAt` | Publication date (when provided) |

---

## Platforms supported

| Platform | Status | Typical use |
|----------|--------|-------------|
| Greenhouse | Shipped | Most widely used ATS in tech |
| Ashby | Shipped | Growing fast with startups |
| Lever | Shipped | Common at mid-stage companies |
| BambooHR | Planned | Mid-market companies |
| Workday | Planned | Large enterprises |

Adding a new ATS is a single adapter file. See [Contributing](#contributing).

---

## Filters (quick reference)

| Flag | What it matches | Use for |
|------|-----------------|---------|
| `--title-filter` | Title only | Role identity (PM, engineer, designer) |
| `--filter` | Title + department + description | Topic or scope (integrations, growth) |
| `--posted-within-days` | Recent postings | Recency cuts |
| `--location-include` | Location contains any keyword | Region targeting |
| `--location-exclude` | Location contains no keyword | Drop geographic noise |
| `--limit` | First N results | Cap output size |

All filters AND together. Deep dive on patterns and gotchas: [docs/filters.md](docs/filters.md).

---

## Roadmap

**Shipped**
- Library, CLI, and MCP server (three surfaces of one toolkit)
- Greenhouse, Ashby, Lever adapters
- Title, topic, location, and date filters
- Salary extraction from JD text
- Verified company registry (66 companies)

**Next**
- Anthropic MCP marketplace submission
- Setup guide with screenshots (non-technical walkthrough)
- Remote MCP transport (for Claude.ai Custom Connectors)

**Planned**
- BambooHR and Workday adapters
- Temporal tracking (when roles open, close, reopen)
- Change detection
- Resume-aware fit scoring

---

## Contributing

**Add a company to the registry:** submit a PR to the appropriate file in `registry/`.

**Add an ATS adapter:** new file in `src/adapters/`. One adapter, one file. Follow the pattern of the existing three.

**Request a company:** [open an issue](https://github.com/prPMDev/jd-intel/issues/new). Tell me who's missing.

---

## Built by

**[Prashant R](https://prashantrana.xyz)**. PM who builds. I write about what actually happens at the layer below the AI hype.

- Portfolio and writing: [prashantrana.xyz](https://prashantrana.xyz)
- [LinkedIn](https://www.linkedin.com/in/prashant-rana)

## License

MIT
