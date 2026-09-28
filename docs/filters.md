# Filter design

jd-intel gives you six filter controls that operate on structured fields. All are deterministic substring, regex, or date matches. No NLP, no magic. For semantic cuts ("is this role senior enough", "is this truly remote-friendly"), let an AI layer or your own downstream logic reason over the returned jobs.

This doc covers each filter, why the design is shaped this way, and the practical patterns that work in real queries.

---

## The six flags

| Filter | Matches | Use when |
|--------|---------|----------|
| `titleFilter` | Title only | Role identity: "what KIND of role" |
| `filter` | Title + department + description | Topic or scope: "what it's ABOUT" |
| `postedWithinDays` | `postedAt` within N days | Recency cuts |
| `locationIncludes` | ANY of the job's locations contains ANY keyword (OR) | Region targeting |
| `locationExcludes` | Drops a job only when EVERY one of its locations contains a keyword | Drop geographic noise |
| `limit` | First N results after filtering and sorting | Cap output size |

All filters AND together.

### Order and paging

Matches are sorted before `limit` applies: newest first by `postedAt`, undated jobs last, ties broken by `id`. So a cut drops the oldest matches, which are the ones most likely dead. `order: 'board'` keeps the ATS's own order instead. `offset` skips the first N sorted matches, which is how you page. `fetchJobsDetailed` returns `total_matched` next to the page, so a caller can tell "this company has 12 matching roles" from "12 of 340 came back". On Workday, the adapter picks the postings it hydrates in board order before the sort, at most 100 per call, so `offset` pages there can repeat or skip a posting and `total_matched` can be a lower bound until [#26](https://github.com/prPMDev/jd-intel/issues/26) ships its scan report.

---

## Why title and topic are separate flags

A single `--filter "product manager"` creates false positives. Engineering JDs that mention "the product manager" as a collaborator get returned as if they were PM roles. The same keyword means different things in different fields:

- In a **title**, "product manager" means *this role IS a PM*
- In a **description**, "product manager" usually means *this role works with PMs*

The fix: two flags for two intents.

- `titleFilter`: role identity gate (title only)
- `filter`: topic or scope match (searches anywhere)

They AND together:

```bash
# "PM roles about integrations": title gate + topic match
npx jd-intel fetch stripe \
  --title-filter "product manager" \
  --filter "integrations|partnerships"
```

Without the split, you'd pull every engineering role whose JD mentions PMs as cross-functional partners.

---

## Match scope to signal strength

Different signals live reliably in different fields:

| Signal | Reliable field | Why |
|--------|----------------|-----|
| Role identity (PM, Staff Eng) | Title | Titles declare role; descriptions mention other roles in context |
| Seniority (Senior, Staff, Principal) | Title | Same as role identity |
| Topic or focus (integrations, growth) | Anywhere | Topics surface in title, dept, or description |
| Tech stack (Python, Postgres) | Description | Rarely in title |

A single filter applied to everything inverts signal strength. Split flags let each filter match its natural field.

---

## Location: prefer include over exclude

**Include is bounded. Exclude is infinite.**

Excluding non-US locations requires enumerating London, Dublin, Berlin, Paris, Singapore, Bangalore, São Paulo, Tokyo, Sydney, and on. Miss one and noise slips through silently. Include is a finite list of exactly what you want.

```bash
# Good: include bounds the set
--location-include "United States,US,Remote - US"

# Use exclude as a refinement, not the primary tool
--location-include "United States,US,Remote - US" \
  --location-exclude "Remote - EMEA,Remote (LatAm)"
```

Missed inclusions are visible. Fewer results prompt you to relax the list. Missed exclusions are silent. Noise leaks in and you don't know why.

### The "Remote" trap

Bare `Remote` is too broad. It substring-matches:

- `Remote`: matches (what you want)
- `Remote - US`: matches (what you want)
- `Remote (LatAm)`: matches (probably not what you want)
- `Remote - EMEA`: matches (probably not what you want)

Prefer qualified terms:

- `Remote - US`, `Remote (US)`: US-specific
- `Remote - Global`: explicitly worldwide
- Pair `Remote` with country keywords in the same include list

### Short tokens: word-boundary matching

Keywords of 4 characters or fewer use word-boundary matching automatically. Longer keywords use substring matching.

This prevents silent false positives on short country codes:

| Keyword | Location | Matches? | Why |
|---------|----------|----------|-----|
| `US` | `San Francisco, US` | Yes | US is a standalone word |
| `US` | `Remote - US` | Yes | Same |
| `US` | `Australia` | No | "us" inside "australia" isn't a word |
| `US` | `Brussels`, `Belarus`, `Lausanne` | No | Same reason |
| `UK` | `London, UK` | Yes | UK is a standalone word |
| `UK` | `Kyiv, Ukraine` | No | "uk" is inside "ukraine" |
| `United States` | `United States of America` | Yes | Substring match for longer keywords |
| `EMEA` | `Remote - EMEA` | Yes | 4-char boundary, still matches cleanly |

So `US` and `UK` are safe to pass as-is. The implementation prevents the substring collisions that would otherwise silently return Australian or Belgian jobs to a US query, or Ukrainian jobs to a UK query.

The Workday adapter filters list rows by location before it fetches job details, and it uses this same matcher. So a Workday board returns the same set as any other ATS for the same keywords, and no detail fetch is spent on a row that matches only as a substring.

### Jobs open in several locations

Lever, Ashby, Recruitee, Teamtailor and Workday can list one posting in several places. `locations` carries all of them, primary first, and both location filters check every entry:

- `locationIncludes` keeps the job when any listed location matches any keyword. A role open in Berlin and New York matches `["New York"]`.
- `locationExcludes` drops the job only when every listed location matches. The same role survives `["US"]`, because it is still open in Berlin for someone who wants to stay out of the US. It drops under `["Germany", "US"]`.

The two still compose the same way: include first, exclude as the refinement. A job with a single location behaves exactly as before.

---

## Date filtering

`postedWithinDays` operates on the normalized `postedAt` field. Jobs without a `postedAt` timestamp are excluded conservatively. Unknown age usually means old.

```bash
# "Posted this week"
--posted-within-days 7

# "Posted this month"
--posted-within-days 30
```

---

## Practical patterns

**Daily scan at a target company:**
```bash
npx jd-intel fetch stripe \
  --posted-within-days 2 \
  --location-include "United States,Remote - US"
```

**Sector sweep for a role type:**
```bash
# Get company slugs
npx jd-intel registry search fintech

# For each, fetch_jobs with a title filter
npx jd-intel fetch ramp --title-filter "product manager"
npx jd-intel fetch plaid --title-filter "product manager"
```

**Noise-free PM-scope search** (the canonical example):
```bash
npx jd-intel fetch securityscorecard \
  --title-filter "product manager" \
  --filter "partnerships|integrations|ecosystem" \
  --location-include "United States,US,Remote - US" \
  --posted-within-days 30
```

Returns PM roles whose scope is partnerships, integrations, or ecosystem, US-based, posted in the last month. No engineering-JD false positives, no EMEA pollution.

---

## Design principle

Filters operate on facts. Interpretations stay with the caller.

**Facts:** keyword presence, date ranges, substring matches. Deterministic, fast. Run them on the server.

**Interpretations:** "Is this truly remote-friendly?" "Does the seniority match what I want?" "Is this on my trajectory?" These require reasoning. Let an AI layer or downstream logic handle them over the filtered output.

This split keeps the tool transparent (you see exactly why each job matched) and efficient (AI doesn't burn tokens doing filtering the server can do deterministically).
