/**
 * Tool descriptions — the semantic contract each tool exposes to the AI.
 *
 * These strings are loaded into the AI's context on every turn. Every
 * sentence must earn its place. Dense > long. Target: 200-400 tokens each.
 *
 * Updating these strings is a product decision, not a docs task —
 * the AI's behavior changes immediately when descriptions change.
 */

export const FETCH_JOBS = `Fetch open job postings from a specific company's ATS (Greenhouse, Lever, Ashby, SmartRecruiters, Teamtailor, Recruitee, Workday).

USE WHEN: the user asks about roles at a known company ("Is Stripe hiring?", "What's open at Figma?").

DON'T USE WHEN:
- User doesn't know the company → read the registry Resource or call search_registry
- User only asks which ATS a company uses → call detect_ats

ARGUMENT GUIDE:

company: lowercase slug, no spaces (e.g. "stripe", "cockroachlabs"). Hyphens and spaces auto-stripped.

title_filter: JavaScript-compatible regex matched against TITLE ONLY. Case-insensitive by default. Do NOT use inline flags like (?i) (not supported by V8). Use for role identity ("product manager", "staff engineer"). Does NOT match description text. That's the distinction from filter.

filter: JavaScript-compatible regex matched across title + department + description. Case-insensitive by default. Do NOT use inline flags like (?i). Use for topic/scope ("integrations", "growth"). AND'd with title_filter.

posted_within_days: number. "recent" or "new" → 30. "this week" → 7. "today" → 1.

location_includes: array of keywords. Case-insensitive substring match; short codes (US, UK) use word-boundary matching automatically. Checked against every entry of a job's locations array: a job open in Berlin and New York matches ["New York"]. For US queries prefer ["United States", "US", "Remote - US"]. Avoid bare "Remote". It matches Remote-EMEA, Remote-LatAm.

location_excludes: array. Drops a job only when every one of its locations matches a keyword: the Berlin and New York job survives ["US"] because it is still open in Berlin, and drops under ["Germany", "US"]. Use as refinement on top of includes.

limit: max jobs per page, default 100. The response is bounded by max_tokens first, so on a large board a default call returns a few complete postings. total_matched and truncated say what was left out.

max_tokens: response budget, default 12000, range 2000 to 40000, counted as characters/4 of the text block. Whole postings only: output stops before the job that would pass the budget, never mid-description, and at least one job is always returned even when it alone exceeds the budget. The payload is sent twice (text and structuredContent), so the wire carries about double.

offset: matches to skip, default 0. For the next page pass offset = next_offset from the previous response. Every page fetches the whole board again, so narrow the filters before paging.

order: "newest" (default) sorts by postedAt, undated last, ties by id. "board" keeps the ATS's own order. Sorting happens before limit, offset and the budget, so a cut drops the oldest matches first.

workday: optional { tenant, env, site }. Use ONLY for a Workday company not in the registry when the user gives a careers URL. Derive from https://{tenant}.{env}.myworkdayjobs.com/{site}: tenant is the first label, env is the part like wd108, site is the path segment. Overrides the registry for that fetch. Never guess or fabricate these values; use only what the user supplied or what is literally in the careers URL. Omit this argument entirely if you do not have a real URL.

RESPONSE: { status, data: [jobs], metadata: { count, registry_hit, ats, workday_override, version, registry_source, total_matched, truncated, est_tokens, offset, next_offset, order } }. Check status first. count is the number of jobs returned. total_matched is how many matched the filters before offset, limit and the budget. truncated is null, or { reason: "limit" | "size", not_returned } naming the cut that stopped output. When truncated is set, narrow with title_filter, location or posted_within_days, or fetch the next page with offset = next_offset (null when nothing is left). On Workday and SmartRecruiters, total_matched, truncated and next_offset describe only the postings the adapter read, at most 100 per call, so total_matched can be a lower bound and offset pages can repeat or skip a posting until #26 ships its scan report. est_tokens is characters/4 of the text block. order is the order in effect.

Each job carries location (the primary), locations (every place it is open in, primary first) and workplace { type, source }. type is remote, hybrid, onsite or unknown; source is ats when the platform stated it, text when read from the location string, null when unknown. locationType repeats workplace.type.

AGE: results are newest first unless order says otherwise. A posting older than about 90 days is usually dead or evergreen. fetch_jobs still returns them; posted_within_days: 90 leaves them out. When a returned posting is that old, say its age.

ERROR CODES:
- company_not_found: slug not in registry, not detected
- ats_unreachable: known ATS failed, or a supplied workday {tenant,env,site} was rejected by Workday
- invalid_args: missing/malformed args, including an incomplete workday triple
- rate_limited: upstream 429
- internal_error: unexpected server failure, not an argument problem. Retry once; if it repeats, tell the user.`;

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
- invalid_args: both query and sector missing
- internal_error: unexpected server failure, not an argument problem. Retry once; if it repeats, tell the user.`;

export const DETECT_ATS = `Detect which ATS platform (Greenhouse, Lever, Ashby, SmartRecruiters, Teamtailor, Recruitee) a company uses by probing. Workday is registry-only and never returned here; find Workday-hosted companies via search_registry or fetch_jobs (which auto-detects from the registry).

USE WHEN: user asks about the ATS platform explicitly ("What ATS does Stripe use?") or for debugging.

DON'T USE WHEN: you want to fetch jobs. Call fetch_jobs directly (it auto-detects internally).

ARGUMENT GUIDE:

company: company name or slug. Hyphens and spaces stripped automatically ("Cockroach Labs" → "cockroachlabs").

RESPONSE: { status, data: "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "teamtailor" | "recruitee" | null, metadata }. data === null means none of the probeable ATS host this company (Workday is registry-only and never detected here). "partial" status means some probes failed. Result may be incomplete.

ERROR CODES:
- invalid_args: company arg missing
- partial_failure: some probes failed
- internal_error: unexpected server failure, not an argument problem. Retry once; if it repeats, tell the user.`;

export const REGISTRY_RESOURCE = `The full jd-intel company registry, grouped by ATS platform.

Use for broad surveys ("what fintech companies are indexed?", "tell me about the catalog"). Fetched once per session, then cached. Cheaper than repeated search_registry calls for multi-query reasoning.

Shape: { greenhouse: [{slug, name, sector}], lever: [...], ashby: [...], smartrecruiters: [...], teamtailor: [...], recruitee: [...], workday: [...] }.`;
