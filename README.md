# jd-intel

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 18+](https://img.shields.io/badge/node-18%2B-green.svg)](https://nodejs.org)
[![npm](https://img.shields.io/npm/v/jd-intel.svg)](https://www.npmjs.com/package/jd-intel)
[![jd-intel downloads](https://badgen.net/npm/dt/jd-intel?label=jd-intel)](https://www.npmjs.com/package/jd-intel)
[![jd-intel-mcp downloads](https://badgen.net/npm/dt/jd-intel-mcp?label=jd-intel-mcp)](https://www.npmjs.com/package/jd-intel-mcp)
[![GitHub stars](https://img.shields.io/github/stars/prPMDev/jd-intel.svg?style=flat)](https://github.com/prPMDev/jd-intel/stargazers)

> **Stop pasting job descriptions into AI assistants. Let your AI fetch them directly.**

Full text. Clean structure. Across seven major ATS. No copy-paste. No context loss.

---

## Why this exists

Your AI assistant already knows a lot about you. Your resume is in its memory. Your target roles, your past projects, your background. Ready to help the moment you feed it a job description.

So you copy-paste.

A JD from one company. Another from the next. A half-dozen more from your target list. Half have broken HTML. Salary info dies in translation. Links get stripped. And for every role, the dance starts over.

You could wait for the job boards to ship their own MCPs. They'll get there eventually. On their timeline. Filtered through their priorities, not yours. Tied to their query abstractions.

jd-intel skips that wait. Raw JDs, fetched directly by your AI, on your terms. One level below the curated layer.

Try asking your AI:

> "Find AI/ML engineering jobs posted this week."
> "What product designer roles are open at fintechs right now?"
> "Pull the staff PM roles posted in the last 7 days."

Done.

---

## Why not just scrape?

Because scraping breaks where jd-intel doesn't:

- **Full JDs when browsing fails.** SPA-rendered boards, slow loads, auth walls, and geo-restrictions block a browser. They don't block a public API call.
- **Structured data, not HTML soup.** Salary, location type, department, and clean markdown, normalized across seven ATS.
- **No keys, no browser.** Public APIs only. Runs anywhere your AI does.
- **One schema, every platform.** Greenhouse, Lever, Ashby, SmartRecruiters, Teamtailor, Recruitee, Workday return the same shape.

---

## What you can do with it

- Look up open roles at any company directly from your AI, no copy-paste
- Tailor your resume across ten roles in one conversation
- Rank openings by fit with your background
- Scan a whole sector: "Pull open roles at fintech companies posted this week"
- Research teams by reading their JDs in bulk

The toolkit fetches. Your AI thinks.

---

## Install

Works with MCP-aware AI clients: Claude Desktop, Claude Code, Cursor, Windsurf, VS Code. ChatGPT, Gemini, and other non-MCP clients don't support this yet. They use different tool-calling systems. (We wish they did. The protocol works the same way regardless of which AI you talk to.)

Everything runs locally on your machine. That also means desktop only: mobile apps can't run a local MCP server, so jd-intel isn't available on phones or tablets.

### Claude Desktop (one-file install, no terminal)

The simplest path. No Node.js, no terminal: Claude Desktop runs the server on its own bundled runtime.

1. **Download** the extension: [jd-intel.mcpb](https://github.com/prPMDev/jd-intel/releases/latest/download/jd-intel.mcpb).
2. In Claude Desktop, open **Settings**, then **Extensions**, then **Advanced settings**, and click **Install Extension**. Pick the file you downloaded.
3. Review the access summary, click **Install**, then start a new chat. The tools appear automatically.

Shortcuts: drag the `.mcpb` onto the Settings window, or double-click it when your system opens `.mcpb` files with Claude Desktop. The extension is open source and unsigned, so Claude Desktop shows an "unverified" notice. Choose **Install Anyway**.

Prefer the terminal, or on an older Claude Desktop? Install [Node.js 18+](https://nodejs.org/), run `npx jd-intel-mcp install`, then reopen Claude Desktop. Or edit the config file directly, see [Manual install](#manual-install-fallback).

### Other clients (Claude Code, Cursor, Windsurf, VS Code)

One-file `.mcpb` install is a Claude Desktop feature; these clients run the same server via `npx` and need [Node.js 18+](https://nodejs.org/).

**Claude Code**
```bash
claude mcp add jd-intel -- npx -y jd-intel-mcp
```

**Cursor** (Settings, then Tools & MCP, then New MCP Server, or edit `~/.cursor/mcp.json`):
```json
{
  "mcpServers": {
    "jd-intel": { "command": "npx", "args": ["-y", "jd-intel-mcp"] }
  }
}
```

**Windsurf** (Settings, then Tools, then Windsurf Settings, then Add Server, or View Raw Config to edit `mcp_config.json`). Use the same `mcpServers` block as Cursor, then press refresh.

**VS Code** (Copilot agent mode): run the **MCP: Add Server** command, or create `.vscode/mcp.json`. The key is `servers` and the type is `stdio`:
```json
{
  "servers": {
    "jd-intel": { "type": "stdio", "command": "npx", "args": ["-y", "jd-intel-mcp"] }
  }
}
```

### Confirm it's working

Start a new chat and ask: **"What fintech companies are in your jd-intel registry?"** If it lists companies, you're set. Then try the real thing: *"Find senior PM roles open right now that I'd be a fit for."*

**Tools not appearing?**
- Fully quit and reopen the client (quit, do not just close the window). Claude Desktop: system tray then Quit (Windows), or ⌘Q (macOS).
- For npx clients (Claude Code, Cursor, Windsurf, VS Code), run `npx clear-npx-cache`, then restart.
- Confirm `node --version` is 18 or newer for the npx paths. The one-click `.mcpb` does not need Node.

### For developers

```bash
npm install jd-intel
```

```js
import { fetchJobs } from 'jd-intel';

const jobs = await fetchJobs({
  company: '<your-target-company>',
  titleFilter: 'designer',
  postedWithinDays: 14,
  limit: 50,
});
```

CLI usage: `npx jd-intel fetch <company-slug> --title-filter "engineer" --posted-within-days 14`. Full filter reference [below](#filters-quick-reference).

Node.js 18+. No API keys. No configuration.

### Manual install (fallback)

If `npx jd-intel-mcp install` fails, edit the config directly.

**Config file location:**
- **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

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

Restart Claude Desktop.

### Updating

- **Claude Desktop extension (`.mcpb`):** install a newer `.mcpb` over the current one, or manage it in Settings, then Extensions. Remove and reinstall to reset.
- **npx clients (Claude Code, Cursor, Windsurf, VS Code):** `npx -y jd-intel-mcp` picks up new versions from npm's cache (within ~24h). Force it now with `npx clear-npx-cache`, then restart the client.
- **Library or CLI:** `npm install jd-intel@latest` (force latest) or `npm update jd-intel` (respect semver).

The company registry refreshes on its own: jd-intel fetches the current list at startup and falls back to the bundled copy offline, so new companies show up without reinstalling.

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
  "company": "Example Co",
  "title": "Senior Software Engineer, Platform",
  "department": "Engineering",
  "location": "Remote - US",
  "locationType": "remote",
  "salary": { "min": 180000, "max": 240000, "currency": "USD" },
  "description": "Design and build the API surface our customers integrate against...",
  "url": "https://boards.example.com/jobs/12345",
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
| SmartRecruiters | Shipped | Enterprise and mid-market |
| Teamtailor | Shipped | European startups and scale-ups |
| Recruitee | Shipped | Dutch / EU SMBs and scale-ups |
| Workday | Shipped | Large enterprises (registry-keyed) |
| Personio | Planned | German / EU mid-market |

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
- Greenhouse, Ashby, Lever, SmartRecruiters, Teamtailor, Recruitee, Workday adapters
- Title, topic, location, and date filters
- Salary extraction from JD text
- Verified company registry (500+ companies)

**Next**
- Personio adapter (German / EU mid-market)
- Workable adapter (widget API; broad SMB coverage)
- Anthropic MCP marketplace submission

**Planned**
- Temporal tracking (when roles open, close, reopen)
- Change detection
- Resume-aware fit scoring

---

## Contributing

Full details in [CONTRIBUTING.md](CONTRIBUTING.md). The short version:

**Add companies to the registry:** don't hand-edit `registry/*.json`. Stage your candidates in `tmp/candidates.json`, then run the live gate, which calls every board for real and keeps only the ones returning live jobs:

```bash
node scripts/verify-registry.mjs --candidates tmp/candidates.json --limit 50
node scripts/append-registry.mjs
npm run sync:registry-pages
node --test test/*.test.js
```

Entries that haven't passed the gate can't be merged. A board that looks right but returns nothing fails silently inside someone's search, which is worse than the company simply being absent. Workday needs a `config` of `{tenant, env, site}` read off the company's real careers URL, never constructed by pattern. [CONTRIBUTING.md](CONTRIBUTING.md#workday) covers how to find and confirm those.

**Add an ATS adapter:** new file in `src/adapters/`. One adapter, one file. Follow the pattern of the existing adapters.

**Request a company:** [open an issue](https://github.com/prPMDev/jd-intel/issues/new). Tell me who's missing. That's a useful contribution on its own.

---

## Built by

**[Prashant R](https://prashantrana.xyz)**. PM who builds. I try out and build what really matters below the AI hype.

- Portfolio and writing: [prashantrana.xyz](https://prashantrana.xyz)
- [LinkedIn](https://www.linkedin.com/in/prashant-rana)

## License

MIT
