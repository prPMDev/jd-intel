# jd-intel-mcp

MCP server for [jd-intel](https://github.com/prPMDev/jd-intel). Lets any AI assistant (Claude Desktop, Claude Code, Cursor, Windsurf, VS Code) search open job listings across Greenhouse, Lever, Ashby, SmartRecruiters, Teamtailor, Recruitee, and Workday through natural conversation.

> **Stop pasting job descriptions into AI assistants. Let your AI fetch them directly.**

---

## What you can ask

- "Is Stripe hiring PMs in the US?"
- "Find remote engineering roles at fintech companies, posted in the last two weeks, then rank them by fit for a senior backend profile."
- "What companies in your index are in the developer tools space?"
- "Does Figma use Greenhouse or Lever?"

The AI handles the phrasing. The MCP server handles the calls, filters, and normalizes results. No copy-paste.

---

## Install

### Claude Desktop (one-file install, no terminal)

Download [jd-intel.mcpb](https://github.com/prPMDev/jd-intel/releases/latest/download/jd-intel.mcpb), then in Claude Desktop open **Settings**, then **Extensions**, then **Advanced settings**, and click **Install Extension**. Pick the file, review the access summary, click **Install**, and start a new chat. No Node.js needed (Claude Desktop runs it on its own bundled runtime). It's open source and unsigned, so choose **Install Anyway** if prompted.

Prefer the terminal? Install [Node.js 18+](https://nodejs.org/), then run:

```bash
npx jd-intel-mcp install
```

This locates the Claude Desktop config, adds the entry alongside any existing servers, and writes back valid JSON. Quit and reopen Claude Desktop.

### Other clients (Claude Code, Cursor, Windsurf, VS Code)

The same server runs via `npx` (needs Node.js 18+):

- **Claude Code:** `claude mcp add jd-intel -- npx -y jd-intel-mcp`
- **Cursor / Windsurf:** add under `mcpServers` (`command: "npx"`, `args: ["-y", "jd-intel-mcp"]`) in the client's MCP config.
- **VS Code (Copilot agent):** add under `servers` with `"type": "stdio"` in `.vscode/mcp.json`.

### Manual config (fallback)

Edit Claude Desktop's config file directly:

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

Restart Claude Desktop. The tools appear automatically.

---

## Tools exposed

| Tool | Purpose |
|------|---------|
| `fetch_jobs` | Get open roles at a company, with filters for role type, topic, location, and recency |
| `search_registry` | Find companies by name or sector |
| `detect_ats` | Identify which ATS platform a company uses |

Plus one Resource: `registry://jd-intel/all`. Full company registry, grouped by ATS, for broad catalog surveys.

### fetch_jobs: size, order and paging

`fetch_jobs` returns whole postings and bounds the response by tokens, not by job count alone.

- `limit` (default 100) caps jobs per page. `max_tokens` (default 12000, range 2000 to 40000) caps the text block at about four characters per token. The server adds whole jobs in order until the next one would pass the budget. It never cuts a description and always returns at least one job.
- `order` is `"newest"` (default: by `postedAt`, undated last, ties by `id`) or `"board"` (the ATS's own order). Sorting runs before the cut, so a cut drops the oldest matches first.
- `offset` (default 0) skips the first N matches after sorting. Pass `offset = metadata.next_offset` for the next page. Every page fetches the board again, so narrow the filters first.

Each success adds to `metadata`: `total_matched` (matches after filters, before offset, limit and the budget), `truncated` (`null`, or `{ reason: "limit" | "size", not_returned }`), `est_tokens` (characters/4 of the text block), `offset`, `next_offset` (`null` when nothing is left) and `order`. `count` stays the number of jobs returned. On Workday and SmartRecruiters, `total_matched`, `truncated` and `next_offset` describe only the postings the adapter read, at most 100 per call, so the total can be a lower bound and offset pages can repeat or skip a posting until [#26](https://github.com/prPMDev/jd-intel/issues/26) ships its scan report.

---

## Filter design

See the main library [docs/filters.md](../docs/filters.md) for the full rationale. Short version:

- Use `title_filter` for role identity ("product manager", "staff engineer"). Matches title only.
- Use `filter` for topic or scope ("integrations", "growth"). Matches across title, department, description.
- They AND together. Use both for "PM roles about integrations".
- For US queries: `location_includes: ["United States", "US", "Remote - US"]`. Avoid bare "Remote" (matches Remote-EMEA etc.).
- Short codes like "US", "UK" are safe. They use word-boundary matching to prevent collisions with "Australia", "Ukraine", etc.

---

## Local development

```bash
cd mcp
npm install
node server.js
```

The server prints `jd-intel MCP server running on stdio` and then listens on stdin/stdout. For quick testing, point Claude Desktop at the local path:

```json
{
  "mcpServers": {
    "jd-intel-dev": {
      "command": "node",
      "args": ["/absolute/path/to/jd-intel/mcp/server.js"]
    }
  }
}
```

---

## Response shape

All three tools return a uniform envelope:

```json
{
  "status": "success" | "partial" | "error",
  "data": <tool-specific>,
  "metadata": {
    "attempted": [...],
    "succeeded": [...],
    "failed": {...},
    "notes": [...]
  }
}
```

On errors, the envelope adds `"error": { "code", "message" }`. Error codes come from a fixed taxonomy (`company_not_found`, `ats_unreachable`, `invalid_args`, `partial_failure`, `rate_limited`, `no_results`, `internal_error`). `internal_error` means an exception inside the server, not a problem with the arguments.

The envelope comes back twice in every response: as JSON text for clients that only show text, and as typed `structuredContent` that matches each tool's published `outputSchema`. Error responses also set the protocol's `isError` flag, so clients can show them as failures.

Every tool is marked read-only and safe to repeat. Inputs are strict: an unknown or misspelled argument is rejected with a clear message instead of being silently ignored.

---

## License

MIT
