/**
 * Tool descriptions — the semantic contract each tool exposes to the AI.
 *
 * These strings are loaded into the AI's context on every turn. Every
 * sentence must earn its place. Dense > long. Target: 200-400 tokens each.
 *
 * Updating these strings is a product decision, not a docs task —
 * the AI's behavior changes immediately when descriptions change.
 */

export const FETCH_JOBS = `Fetch open job postings from a specific company's ATS (Greenhouse, Lever, or Ashby).

USE WHEN: the user asks about roles at a known company ("Is Stripe hiring?", "What's open at Figma?").

DON'T USE WHEN:
- User doesn't know the company → read the registry Resource or call search_registry
- User only asks which ATS a company uses → call detect_ats

ARGUMENT GUIDE:

company: lowercase slug, no spaces (e.g. "stripe", "cockroachlabs"). Hyphens and spaces auto-stripped.

title_filter: JavaScript-compatible regex matched against TITLE ONLY. Case-insensitive by default. Do NOT use inline flags like (?i) (not supported by V8). Use for role identity ("product manager", "staff engineer"). Does NOT match description text. That's the distinction from filter.

filter: JavaScript-compatible regex matched across title + department + description. Case-insensitive by default. Do NOT use inline flags like (?i). Use for topic/scope ("integrations", "growth"). AND'd with title_filter.

posted_within_days: number. "recent" or "new" → 30. "this week" → 7. "today" → 1.

location_includes: array of keywords. Case-insensitive substring match; short codes (US, UK) use word-boundary matching automatically. For US queries prefer ["United States", "US", "Remote - US"]. Avoid bare "Remote". It matches Remote-EMEA, Remote-LatAm.

location_excludes: array. Drop jobs whose location contains any keyword. Use as refinement on top of includes.

limit: default 100. Reduce for high-volume companies.

RESPONSE: { status, data: [jobs], metadata: { attempted, succeeded, failed, notes } }. Check status first. "partial" means some adapters failed. Tell the user results may be incomplete.

ERROR CODES:
- company_not_found: slug not in registry, not detected
- ats_unreachable: known ATS failed
- invalid_args: missing/malformed args
- rate_limited: upstream 429`;

export const SEARCH_REGISTRY = `Find companies in the indexed registry by name or sector.

USE WHEN: targeted lookups ("Is Stripe in your index?", "Show me fintech companies").

DON'T USE WHEN:
- User wants a broad survey of the catalog → read the registry://jd-intel/all Resource instead (one fetch vs repeated tool calls)
- User asks about a specific company's jobs → call fetch_jobs directly

ARGUMENT GUIDE:

query: optional. Substring match (case-insensitive) against company name.
sector: optional. Match against sector field. Examples: "fintech", "developer tools", "marketing tech".

At least one argument required. Returns companies matching either.

RESPONSE: { status, data: [{ slug, name, sector, ats }], metadata }. Each result includes the ATS platform for that company.

ERROR CODES:
- invalid_args: both query and sector missing`;

export const DETECT_ATS = `Detect which ATS platform (Greenhouse, Lever, or Ashby) a company uses.

USE WHEN: user asks about the ATS platform explicitly ("What ATS does Stripe use?") or for debugging.

DON'T USE WHEN: you want to fetch jobs. Call fetch_jobs directly (it auto-detects internally).

ARGUMENT GUIDE:

company: company name or slug. Hyphens and spaces stripped automatically ("Cockroach Labs" → "cockroachlabs").

RESPONSE: { status, data: "greenhouse" | "lever" | "ashby" | null, metadata }. data === null means no supported ATS hosts this company. "partial" status means some probes failed. Result may be incomplete.

ERROR CODES:
- invalid_args: company arg missing
- partial_failure: some probes failed`;

export const REGISTRY_RESOURCE = `The full jd-intel company registry, grouped by ATS platform.

Use for broad surveys ("what fintech companies are indexed?", "tell me about the catalog"). Fetched once per session, then cached. Cheaper than repeated search_registry calls for multi-query reasoning.

Shape: { greenhouse: [{slug, name, sector}], lever: [...], ashby: [...] }.`;
