/**
 * Tool descriptions — the semantic contract each tool exposes to the AI.
 *
 * These strings are loaded into the AI's context on every turn. Every
 * sentence must earn its place. Dense > long. Measured as chars/4 on
 * 2026-09-27: fetch_jobs about 2100 tokens (eleven arguments plus the
 * meaning of every metadata field), search_registry about 360, detect_ats
 * about 600.
 *
 * Format contract, checked by mcp/test/tools.test.js: one "RESPONSE:" line
 * whose `metadata: { ... }` braces name every metadata key the tool can
 * emit, then a "STATUSES:" list and an "ERROR CODES:" list, each entry
 * "- name: meaning". The test produces every named key, status and code
 * through a real Client and fails on any it cannot, and on any the handler
 * emits that is not named.
 *
 * What goes in: routing (USE WHEN / DON'T USE WHEN), arguments, what each
 * field and status means, and the staleness guidance. Facts about the data.
 * Nothing on how to reason about a result or what to tell the user.
 *
 * Updating these strings is a product decision, not a docs task —
 * the AI's behavior changes immediately when descriptions change.
 */

export const FETCH_JOBS = `Fetch open job postings from one company's ATS board (Greenhouse, Lever, Ashby, SmartRecruiters, Teamtailor, Recruitee, Workday).

USE WHEN: the user asks about roles at a known company ("Is Stripe hiring?", "What's open at Figma?").

DON'T USE WHEN:
- User doesn't know the company → read the registry Resource or call search_registry
- User only asks which ATS a company uses → call detect_ats

ARGUMENT GUIDE:

company: lowercase slug, no spaces (e.g. "stripe", "cockroachlabs"). Hyphens and spaces auto-stripped. A registry slug costs one board fetch; any other slug is probed on every probeable ATS.

title_filter: JavaScript-compatible regex matched against TITLE ONLY. Case-insensitive by default. Do NOT use inline flags like (?i) (not supported by V8). Use for role identity ("product manager", "staff engineer"). Does NOT match description text. That's the distinction from filter.

filter: JavaScript-compatible regex matched across title + department + description. Case-insensitive by default. Do NOT use inline flags like (?i). Use for topic/scope ("integrations", "growth"). AND'd with title_filter.

posted_within_days: number. "recent" or "new" → 30. "this week" → 7. "today" → 1.

location_includes: array of keywords. Case-insensitive substring match; short codes (US, UK) use word-boundary matching automatically. Checked against every entry of a job's locations array: a job open in Berlin and New York matches ["New York"]. For US queries prefer ["United States", "US", "Remote - US"]. Avoid bare "Remote". It matches Remote-EMEA, Remote-LatAm.

location_excludes: array. Drops a job only when every one of its locations matches a keyword: the Berlin and New York job survives ["US"] because it is still open in Berlin, and drops under ["Germany", "US"]. Use as refinement on top of includes.

limit: max jobs per page, default 100. max_tokens usually stops output first, so on a large board a default call returns a few complete postings. total_matched and truncated say what was left out.

max_tokens: response budget, default 12000, any integer from 1, counted as characters/4 of the text block. Whole postings only: output stops before the job that would pass the budget, never mid-description, and at least one job is always returned even when it alone exceeds the budget. A larger value returns more complete postings per call; a smaller one is a quick scan. The payload is sent twice (text and structuredContent), so the wire carries about double.

offset: matches to skip, default 0. next_offset from the previous response is the next page. Every page fetches the whole board again.

order: "newest" (default) sorts by postedAt, undated last, ties by id. "board" keeps the ATS's own order. Sorting happens before limit, offset and the budget, so a cut drops the oldest matches first. On a capped board (counts_exact false) the sort covers only the rows read so far, so "newest" pages can repeat or skip rows; "board" pages a capped board in a stable order.

workday: optional { tenant, env, site }. Use ONLY for a Workday company not in the registry when the user gives a careers URL. Derive from https://{tenant}.{env}.myworkdayjobs.com/{site}: tenant is the first label, env is the part like wd108, site is the path segment. Overrides the registry for that fetch. Never guess or fabricate these values; use only what the user supplied or what is literally in the careers URL. Omit this argument entirely if you do not have a real URL.

An argument that fails the input schema (wrong type, out of range, unknown key, a blank workday field) returns isError with plain text naming the field and no envelope; fix that argument and call again.

RESPONSE: { status, data: [jobs] | null, metadata: { count, registry_hit, ats, workday_override, version, registry_source, total_matched, total_before_filters, match, company, boards, failed, counts_exact, truncated, est_tokens, offset, next_offset, order } }.

count: jobs in data. total_matched: jobs that passed the filters, before offset, limit and the budget. total_before_filters: rows the boards listed before any filter; count 0 with total_before_filters above 0 is a board with openings where none passed the filters.

match: how the company was resolved. "registry": the slug is a registry row and that board was fetched. "probe": the slug is not in the registry and every probeable ATS was asked; a board that answered belongs to whoever owns that slug on that ATS, and the registry does not vouch that it is the company asked about. "workday_override": the workday argument named the board. registry_hit is match === "registry". company: { key, name } from the registry row on a registry match, else null.

boards: one entry per board that answered, [{ ats, slug, name, site, board_url, org_name, org_url, jobs_found, matched, selected, scan }]. name: the registry row's name, null on a probe or an override. site: the Workday career site, else null. org_name, org_url: the organization name and careers host the board itself states, null where its platform exposes none (Lever and Ashby expose neither; org_url is null when the only host is the ATS's own). jobs_found: the board's list before filters. matched: its rows after filters. selected: true. scan: { listed, prefiltered, hydrated, capped } on Workday and SmartRecruiters, else null. ats: the one ATS every board shares, null when they differ. failed: adapters a probe could not check, [{ ats, slug, name, code, message }]; a failed adapter is neither a match nor a miss. On an error, metadata.failed is present only when a probe found no board; a registry or override board's own failure carries no metadata.

counts_exact: false when a board's scan.capped is true. Workday and SmartRecruiters read at most 100 postings per call, so total_matched and total_before_filters are then floors. truncated: null, or { reason: "limit" | "size" | "scan_cap", not_returned }: "limit" when more matched than the page holds, "size" when max_tokens stopped output, "scan_cap" when nothing cut the page but a board's scan was capped. not_returned is the count left after this page, null when counts_exact is false. next_offset: offset for the next page, null when nothing is left. With counts_exact false it is also set whenever the page filled, since a capped board holds rows the scan did not read; the page it names comes back with count 0 and truncated scan_cap once the cap is reached. est_tokens: characters/4 of the text block. order: the order in effect. workday_override: the workday argument was used. version: server version. registry_source: "network", "disk-fallback" (the bundled copy) or "mixed".

Each job carries location (the primary), locations (every place it is open in, primary first) and workplace { type, source }. type is remote, hybrid, onsite or unknown; source is ats when the platform stated it, text when read from the location string, null when unknown. locationType repeats workplace.type.

AGE: results are newest first unless order says otherwise. A posting older than about 90 days is usually dead or evergreen. fetch_jobs still returns them; posted_within_days: 90 leaves them out.

STATUSES:
- success: every board asked answered (failed is empty). data may be []. A registry board or a workday override that the ATS answers with 404 (no board at that slug, a site Workday does not know) is a board with total_before_filters 0, not an error.
- partial: at least one board answered and at least one adapter is in failed. data holds what the answering boards returned.
- error: no board answered. data is null and error.code says why.

ERROR CODES:
- company_not_found: the slug is not in the registry, no probeable ATS listed a posting under it, and every check completed. An unregistered board with zero postings reads the same way.
- ats_unreachable: the board's ATS failed (5xx, a 4xx other than 404 or 429, a network error, a timeout), a supplied workday triple failed the same way (a 404 is a board with zero rows, see success), or a probe found no board and a check failed with no 429. On a probe, metadata.failed lists the failed checks.
- rate_limited: the board's ATS returned 429, or a probe found no board and a check failed with a 429. On a probe, metadata.failed lists the failed checks.
- invalid_args: a filter regex that does not compile, or an empty company.
- internal_error: an exception inside the server, not an argument problem.`;

export const SEARCH_REGISTRY = `Find companies in the indexed registry by name or sector.

USE WHEN: a company name or a sector word is in hand ("Is Stripe in your index?", "Show me fintech companies").

DON'T USE WHEN:
- User wants the whole catalog, across every sector → read the registry://jd-intel/all Resource instead (one large read)
- User asks about a specific company's jobs → call fetch_jobs directly

ARGUMENT GUIDE:

query: optional. Case-insensitive substring match against company name or sector.
sector: optional. Case-insensitive substring match against sector only ("fintech", "developer tools").
limit: optional. Max rows returned, default 50, max 200.

At least one is required. Passing both narrows: a row must match query (on name or sector) and sector (AND). An argument that fails the input schema (wrong type, unknown key) returns isError with plain text naming the field and no envelope; fix that argument and call again.

RESPONSE: { status, data: [{ slug, name, sector, ats }] | null, metadata: { count, total, truncated, query, sector, version, registry_source } }. Each row is one board; ats is the platform it is on. Rows are ranked: an exact name or slug, then names starting with the query, then names containing it, then sector-only matches. count is rows in data. total is every row that matched. truncated: null, or { reason: "limit", not_returned } when more matched than limit; narrow the term or combine query with sector before raising limit. query and sector echo the arguments, null when not passed. registry_source is "network", "disk-fallback" (the bundled copy) or "mixed".

STATUSES:
- success: the registry was searched. data may be [].
- error: data is null and error.code says why.

ERROR CODES:
- invalid_args: both query and sector missing.
- internal_error: an exception inside the server, not an argument problem.`;

export const DETECT_ATS = `List the ATS platforms a company answers on: registry rows first (all seven platforms, Workday included, no request made), then a live probe of every probeable ATS (Greenhouse, Lever, Ashby, SmartRecruiters, Teamtailor, Recruitee) the registry did not list. Workday cannot be probed, so a Workday board appears only from the registry.

USE WHEN: user asks about the ATS platform explicitly ("What ATS does Stripe use?") or for debugging.

DON'T USE WHEN: you want to fetch jobs. Call fetch_jobs directly (it auto-detects internally).

ARGUMENT GUIDE:

company: company name or slug. Hyphens and spaces stripped automatically ("Cockroach Labs" → "cockroachlabs"). A missing or non-string company or an unknown key fails the input schema and returns isError with plain text naming the field and no envelope; fix that argument and call again.

RESPONSE: { status, data: "greenhouse" | "lever" | "ashby" | "smartrecruiters" | "teamtailor" | "recruitee" | "workday" | null, metadata: { attempted, succeeded, boards, failed, notes } }.

boards: every board known for this slug, [{ ats, slug, source }], in platform order. source "registry": a registry row, not probed. source "probe": the ATS answered to this slug live; the registry does not vouch that it is the company asked about. A listed board exists and may hold zero postings. data: the ats of the first board, null when boards is empty. succeeded: the ats of each board. attempted: the ATS probed live (every probeable ATS the registry did not list). failed: probes that could not be checked, [{ ats, slug, code, message }]; a failed probe is neither a match nor a miss. notes: present only when boards spans several platforms, stating that data is the first in platform order, not a ranking, and that every board is in metadata.boards.

STATUSES:
- success: every probe completed (failed is empty). data null with boards empty means no registry row and no probeable ATS answered.
- partial: at least one board is known and at least one probe is in failed.
- error: no board is known and at least one probe failed. data is null.

ERROR CODES:
- rate_limited: no board is known and a failed probe was a 429. metadata.failed lists them.
- ats_unreachable: no board is known and every failed probe was a 5xx, another 4xx, a network error or a timeout. metadata.failed lists them.
- internal_error: an exception inside the server, not an argument problem.`;

export const REGISTRY_RESOURCE = `The full jd-intel company registry, grouped by ATS platform.

Use for questions that need the whole catalog ("what sectors do you cover?", "tell me about the catalog"). It is a large read, about 1,000 rows and 65,000 characters and growing weekly, so for a company name or one sector call search_registry instead.

Shape: { greenhouse: [{slug, name, sector}], lever: [...], ashby: [...], smartrecruiters: [...], teamtailor: [...], recruitee: [...], workday: [...] }.`;
