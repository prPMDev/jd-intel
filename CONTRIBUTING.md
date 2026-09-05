# Contributing to jd-intel

Thanks for helping. Most contributions fall into one of three shapes: adding companies to the registry, adding a new ATS adapter, or fixing something in the library, CLI, or MCP server.

The one rule that applies everywhere: **every registry entry must be live-verified before it lands.** There is tooling for this, described below. It is not a formality. Job boards move, companies switch platforms, and an entry that looks right but returns nothing is worse than no entry at all, because it fails silently in someone's search.

---

## Adding companies to the registry

`registry/*.json` is a catalog of companies whose job boards jd-intel knows how to reach. One file per ATS.

Do not hand-edit these files. They are column-aligned by a script, and hand edits tend to break the alignment or the JSON. Use the pipeline instead.

### 1. Write a candidates file

Create `tmp/candidates.json` (`tmp/` is gitignored):

```json
{
  "greenhouse": [
    {"slug": "acmecorp", "name": "Acme Corp", "sector": "fintech / payments"}
  ],
  "workday": [
    {"slug": "acmeenterprise", "name": "Acme Enterprise", "sector": "insurance",
     "config": {"tenant": "acme", "env": "wd5", "site": "External_Careers"}}
  ]
}
```

- `slug` is the identifier in the board URL. For Workday it is a company-derived slug of your choosing, and the real routing lives in `config`.
- `name` is the official public company name.
- `sector` is lowercase. Check the existing registry files for a term already in use and reuse it rather than inventing a near-duplicate. Use `" / "` for hybrids.
- `config` is Workday only.

### 2. Run the live gate

```bash
node scripts/verify-registry.mjs --candidates tmp/candidates.json --limit 50
```

This calls each board for real and writes `tmp/verify-report.json`. Only entries that return HTTP 200 with at least one live job survive. Entries that come back empty or error are dropped, and the report says why.

If you get HTTP 429, you are being rate-limited. Wait a few minutes and re-run the failures with `--concurrency 1`.

### 3. Append, sync, test

```bash
node scripts/append-registry.mjs
npm run sync:registry-pages
node --test test/*.test.js
```

`append-registry.mjs` reads the survivors from the report and writes them into the right registry files with correct alignment. It refuses anything that did not pass the gate, and it drops any company already registered under a different ATS.

`sync:registry-pages` copies `registry/` to `docs/registry/`, which the GitHub Pages copy serves. The two must move together.

### 4. Open the PR

Say which themes or sectors you sourced, and roughly how many candidates you started with versus how many survived the gate. That context is genuinely useful for review.

---

## Finding the values for each ATS

Slugs come from the public job board URL. The quickest way to confirm one is the probe endpoint in the right-hand column.

| ATS | Board URL | Slug is | Confirm with |
|-----|-----------|---------|--------------|
| Greenhouse | `boards.greenhouse.io/<slug>` | the path segment | `HEAD https://boards-api.greenhouse.io/v1/boards/<slug>` |
| Lever | `jobs.lever.co/<slug>` | the path segment | `HEAD https://api.lever.co/v0/postings/<slug>?mode=json` |
| Ashby | `jobs.ashbyhq.com/<slug>` | the path segment, case-sensitive | `HEAD https://api.ashbyhq.com/posting-api/job-board/<slug>` |
| SmartRecruiters | `careers.smartrecruiters.com/<Slug>` | the path segment, usually PascalCase | `GET https://api.smartrecruiters.com/v1/companies/<slug>/postings?limit=1` |
| TeamTailor | `<slug>.teamtailor.com` | the subdomain | `HEAD https://<slug>.teamtailor.com/jobs.rss` |
| Recruitee | `<slug>.recruitee.com` | the subdomain | `GET https://<slug>.recruitee.com/api/offers/` |
| Workday | see below | company-derived | see below |

A few things that catch people out:

- **Ashby slugs are case-sensitive** and can contain spaces, which appear as `%20` in the URL.
- **SmartRecruiters returns HTTP 200 with zero results for companies that do not exist**, so a 200 alone proves nothing. Require `totalFound > 0`.
- **TeamTailor has regional subdomains.** If the plain slug does not answer, try `<slug>.na.teamtailor.com` and `<slug>.eu.teamtailor.com`.

### Workday

Workday needs three values rather than a slug, and they have to be read off the company's real careers URL. Do not construct them by pattern. Tenants frequently differ from the company name, environments do not follow from anything visible, and site segments are arbitrary.

The URL looks like:

```
https://<tenant>.<env>.myworkdayjobs.com/[optional locale]/<site>
```

`site` is the first path segment that is not a locale like `en-US`. Known `env` values include `wd1`, `wd3`, `wd5`, `wd12`, `wd103`, `wd108`, `wd115`, `wd501`, `wd503` and `wd504`.

Confirm with:

```bash
curl -s -X POST "https://<tenant>.<env>.myworkdayjobs.com/wday/cxs/<tenant>/<site>/jobs" \
  -H "content-type: application/json" \
  -d '{"appliedFacets":{},"limit":1,"offset":0,"searchText":""}'
```

Reading the response:

| Result | Means |
|--------|-------|
| 200 with `total > 0` | Good |
| 200 with `total: 0` | Real board, no live postings. Not eligible. |
| 404 | Wrong site segment |
| 422 | Wrong environment. Try the others, including the `wd50x` family. |
| 401 | Tenant blocks anonymous access. Cannot be supported. |

Some large companies are not on Workday at all despite appearing on customer lists, and some run boards that are closed to anonymous access. Both are normal outcomes. Leave them out rather than guessing.

---

## Adding an ATS adapter

One adapter, one file at `src/adapters/{name}.js`. Follow an existing adapter closely.

- Export `fetch{Name}(slug)` returning a normalized job array. Run results through `normalize()` from `src/normalizer.js`.
- Export `has{Name}(slug)` returning a boolean from a cheap HEAD request. `detect_ats` uses this for probing.
- Register it in `src/adapters/index.js`, in both the `ADAPTERS` map and the `ATS_NAMES` array.
- Add `test/{name}.test.js` using `t.mock.method(global, 'fetch', mockFn)`. The fetch mock auto-restores per test.
- Seed `registry/{name}.json` through the pipeline above.

---

## Code contributions

```bash
npm install
node --test test/*.test.js     # should be green before and after your change
node mcp/server.js             # boot the MCP server locally
```

Keep handlers thin and let the library do the work. If you need filtering, company lookup, or ATS detection, use the exported helpers (`applyFilters`, `findAtsBySlug`, `detectAts`) rather than rebuilding the logic.

A note on user-facing text, which means the README, the docs pages, `mcp/README.md` and `mcp/descriptions.js`: no em dashes, and refer to "AI assistants" or "your AI" rather than naming a specific product. Code comments and JSDoc are exempt from the em dash rule. Comments are for explaining why, not what.

---

## Requesting rather than contributing

If you know a company is missing and would rather not work through the pipeline, [open an issue](https://github.com/prPMDev/jd-intel/issues/new) and name them. That is a useful contribution on its own.
