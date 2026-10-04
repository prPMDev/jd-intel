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
| `detect_ats` | List the ATS platforms a company answers on: registry rows first, then live probes |

Plus one Resource: `registry://jd-intel/all`. Full company registry, grouped by ATS, for broad catalog surveys.

### fetch_jobs: size, order and paging

`fetch_jobs` returns whole postings and bounds the response by tokens, not by job count alone.

- `limit` (default 100) caps jobs per page. `max_tokens` (default 12000, any integer from 1) caps the text block at about four characters per token. The server adds whole jobs in order until the next one would pass the budget. It never cuts a description it has read and always returns at least one job. A larger budget returns more complete postings per call; a smaller one is a quick scan.
- `order` is `"newest"` (default: by `postedAt`, undated last, ties by `id`) or `"board"` (the ATS's own order). Sorting runs before the cut, so a cut drops the oldest matches first. On a capped board (below) the sort covers only the rows read so far, so `"newest"` pages can repeat or skip rows; `"board"` pages a capped board in a stable order.
- `offset` (default 0) skips the first N matches after sorting. Pass `offset = metadata.next_offset` for the next page. Every page fetches the board again, so narrow the filters first.

Workday and SmartRecruiters read at most 100 postings per call. When that cap was hit, `metadata.counts_exact` is `false`, every count is a floor, and `truncated.not_returned` is `null`. A filled page on a capped board still sets `next_offset`, since the board holds rows the scan did not read; the page it names comes back empty (`count: 0`, `truncated.reason: "scan_cap"`) once the cap is reached.

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

## Responses

Every handler returns one envelope, `{ status, data, metadata }`, twice: as JSON text for clients that only show text, and as typed `structuredContent` that matches the tool's published `outputSchema`. `status` is `success`, `partial` or `error`. On `error` the envelope adds `error: { code, message }`, `data` is `null`, and the protocol's `isError` flag is set. `partial` is a usable answer with a caveat in `metadata`; it does not set `isError`.

Arguments that fail a tool's input schema (a wrong type, a value out of range, an unknown or misspelled key, a blank Workday field) never reach the handler. The SDK returns `isError` with plain text naming the field and no envelope. Every tool is marked read-only and safe to repeat.

The codes a handler can emit are `company_not_found`, `ats_unreachable`, `rate_limited`, `invalid_args` and `internal_error`. `internal_error` means an exception inside the server, not a problem with the arguments. The tool descriptions define each code per tool, and a contract test fails the suite when a description names a status, code or metadata key the handler does not emit, or the other way round.

### fetch_jobs

`metadata`: `count`, `registry_hit`, `ats`, `workday_override`, `version`, `registry_source`, `total_matched`, `total_before_filters`, `content_missing`, `match`, `company`, `boards`, `failed`, `counts_exact`, `truncated`, `est_tokens`, `offset`, `next_offset`, `order`.

- `match` says how the company was resolved: `registry` (a registry row, one board fetched), `probe` (not in the registry; every probeable ATS was asked, and a board that answered belongs to whoever owns that slug there) or `workday_override` (the `workday` argument named the board). `registry_hit` is `match === "registry"`. `company` is `{ key, name }` from the registry row on a registry match, else `null`.
- `boards` lists every board that answered: `{ ats, slug, name, site, board_url, org_name, org_url, jobs_found, matched, selected, scan }`. `jobs_found` is the board's list before filters, `matched` its rows after filters. `org_name` and `org_url` are what the board says about itself and are `null` until an adapter reads them. `scan` is `{ listed, prefiltered, hydrated, capped }` on Workday and SmartRecruiters, `null` elsewhere. `ats` is the one ATS every board shares, `null` when they differ.
- `failed` lists adapters a probe could not check: `{ ats, slug, name, code, message }`. A failed adapter is neither a match nor a miss.
- `total_matched` counts matches before `offset`, `limit` and the budget. `total_before_filters` counts rows before any filter, so `count: 0` with `total_before_filters > 0` is a board with openings where none passed the filters. `counts_exact` is `false` when a board's scan was capped. `truncated` is `null` or `{ reason: "limit" | "size" | "scan_cap", not_returned }`, with `not_returned` `null` when counts are not exact. `next_offset` is the next page's offset, `null` when nothing is left; on a capped board it is also set whenever the page filled (see the paging section above). `est_tokens` is characters/4 of the text block.

Statuses: `success` when every board asked answered (`failed` is empty; `data` may be `[]`). A registry board or a Workday override that the ATS answers with 404 (no board at that slug, a site Workday does not know) is a board with `total_before_filters: 0`, not an error. `partial` when at least one board answered and something was not checked: an adapter is in `failed`, or `content_missing` is above 0. `content_missing` counts jobs Workday or SmartRecruiters listed whose detail request failed; each carries `content: { status: "missing", reason }` with an empty `description`, and is counted before the filters. `error` when no board answered: `company_not_found` when the slug is not in the registry, no probeable ATS listed a posting under it and every check completed; `rate_limited` when the board's ATS returned 429, or a probe found no board and a check failed with a 429; `ats_unreachable` when the board's ATS failed otherwise (5xx, a 4xx other than 404 or 429, a network error, a timeout), a supplied Workday triple failed the same way, or a probe found no board and a check failed with no 429. On a probe outage the two codes carry `metadata.failed`; a registry or override board's own failure carries no metadata. `invalid_args` is a filter regex that does not compile or an empty company.

### search_registry

`metadata`: `count`, `total`, `truncated`, `query`, `sector`, `version`, `registry_source`. `query` matches company name or sector; `sector` matches sector only; passing both narrows (AND). Rows are ranked (exact name or slug, name prefix, name substring, sector only) and capped at `limit` (default 50, max 200); `total` counts every match and `truncated` is `{ reason: "limit", not_returned }` when the cap cut the list. Statuses: `success` (`data` may be `[]`) or `error` with `invalid_args` when both arguments are missing.

### detect_ats

`metadata`: `attempted`, `succeeded`, `boards`, `failed`, and `notes` when several boards are known.

- `boards` lists every board known for the slug, `{ ats, slug, source }`, in platform order. `source` is `registry` (a registry row, Workday included, never probed) or `probe` (the ATS answered to this slug live). A listed board exists and may hold zero postings.
- `data` is the `ats` of the first board, or `null` when no board is known. `succeeded` lists each board's `ats`. `attempted` lists the ATS probed live: every probeable ATS the registry did not list. `failed` lists probes that could not be checked, `{ ats, slug, code, message }`.

Statuses: `success` when every probe completed (`data: null` with empty `boards` means no registry row and no probeable ATS answered). `partial` when at least one board is known and at least one probe is in `failed`. `error` with `rate_limited` or `ats_unreachable` when no board is known and a probe failed, with `metadata.failed`.

---

## License

MIT
