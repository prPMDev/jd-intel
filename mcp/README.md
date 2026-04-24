# jd-intel-mcp

MCP server for [jd-intel](https://github.com/prPMDev/jd-intel). Lets any AI assistant (Claude Desktop, Cursor, Windsurf) search open job listings across Greenhouse, Lever, and Ashby through natural conversation.

> **Stop pasting job descriptions into AI assistants. Let your AI fetch them directly.**

---

## What you can ask

- "Is Stripe hiring PMs in the US?"
- "Find remote engineering roles at fintech companies, posted in the last two weeks, then draft a cover letter for the best match."
- "What companies in your index are in the developer tools space?"
- "Does Figma use Greenhouse or Lever?"

The AI handles the phrasing. The MCP server handles the calls, filters, and normalizes results. No copy-paste.

---

## Install (Claude Desktop)

Add this to your Claude Desktop config file:

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

**One-command install (avoids hand-editing the config):**
```bash
npx jd-intel-mcp install
```

This detects your OS, locates the Claude Desktop config, adds the entry alongside any existing servers, and writes back valid JSON. Prevents the "paste-a-snippet-into-existing-config" hand-editing error.

---

## Tools exposed

| Tool | Purpose |
|------|---------|
| `fetch_jobs` | Get open roles at a company, with filters for role type, topic, location, and recency |
| `search_registry` | Find companies by name or sector |
| `detect_ats` | Identify which ATS platform a company uses |

Plus one Resource: `registry://jd-intel/all`. Full company registry, grouped by ATS, for broad catalog surveys.

---

## Filter design

See the main library [docs/filters.md](../docs/filters.md) for the full rationale. Short version:

- Use `title_filter` for role identity ("product manager", "staff engineer"). Matches title only.
- Use `filter` for topic or scope ("integrations", "growth"). Matches across title, department, description.
- They AND together. Use both for "PM roles about integrations".
- For US queries: `location_includes: ["United States", "US", "Remote - US"]`. Avoid bare "Remote" (matches Remote-EMEA etc.).
- Short codes like "US", "UK" are safe. They use word-boundary matching to prevent collisions with "Australia", "Auckland", etc.

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

On errors, the envelope adds `"error": { "code", "message" }`. Error codes come from a fixed taxonomy (`company_not_found`, `ats_unreachable`, `invalid_args`, `partial_failure`, `rate_limited`, `no_results`).

---

## License

MIT
