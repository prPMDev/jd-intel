<!--
  Canonical agent-context file for this repo (follows the agents.md cross-tool standard).
  CLAUDE.md mirrors this file so Claude Code's auto-detection keeps working.
  Edit both files to keep them in sync.
-->

# jd-intel

**Toolkit for making job descriptions AI-accessible.** Library + CLI + MCP server. Published to npm as `jd-intel` (lib/CLI) and `jd-intel-mcp` (MCP server).

Public repo. Open source MIT. Built by Prashant R as a portfolio piece at the intersection of AI, product work, and the integration layer.

---

## PRIME DIRECTIVE: this is a public repo

Anonymity discipline applies throughout, with one explicit exception (author attribution is intentional public credit).

**Always anonymize:**
- Specific companies the author applied to or considered (use "fintech company", "Company X")
- The author's specific past employers (use "previous employer" or generic role descriptions)
- Names of any testers, reviewers, or collaborators (use "an external reviewer", "a tester")
- Internal feedback, NDA-protected discussions, private commentary
- Visa / immigration details
- Specific salary numbers tied to the author's experience
- Family / personal life details

**Allowed (intentional public attribution):**
- Author name: Prashant R
- Portfolio: prashantrana.xyz
- LinkedIn: linkedin.com/in/prashant-rana
- npm package names, GitHub repo URLs, public technical artifacts
- Real ATS platform names (Greenhouse, Lever, Ashby) — these are public products
- Generic role types (PM, engineer, designer) — balance, not pile-on

**Git history is permanent.** Even if you fix it later, old commits remain accessible. Rewriting history is complex and not guaranteed. Better to over-anonymize than expose.

---

## What jd-intel is

A toolkit (three surfaces, one core) for fetching and normalizing job descriptions across major Applicant Tracking Systems:

- **Library** (`jd-intel`) — `fetchJobs`, `searchRegistry`, `detectAts`, `applyFilters`. ESM, Node 18+.
- **CLI** (`npx jd-intel fetch <slug>`) — same capabilities from the terminal.
- **MCP server** (`jd-intel-mcp`) — exposes the toolkit to AI assistants via the Model Context Protocol.

Seven ATS adapters shipped: Greenhouse, Lever, Ashby, SmartRecruiters, TeamTailor, Recruitee, Workday. 700+ company verified registry.

---

## Scope (core principle)

**In scope:** building, maintaining, and **polishing the product** itself — library, CLI, MCP server, tests, releases, README, docs, MCP tool descriptions, voice rules, naming, API design. Refactors, tightening, cleanup, version bumps, all in scope.

**Out of scope:** polishing **learnings** into publishable content. LinkedIn posts, blog posts, course material, conference talks. That track lives in a separate project that consumes from `notes/`. jd-intel sessions capture into `notes/` (raw); a different project handles the publication side.

The distinction: product polish is in. Learning-publication polish is out.

---

## Quick start (developer)

```bash
cd C:\Projects\jd-intel
npm install                       # root deps
cd mcp && npm install             # MCP package deps

node --test test/*.test.js        # 124 tests, all should pass
node mcp/server.js                # boot MCP server locally
```

---

## File structure orientation

```
jd-intel/
├── src/                          # Library
│   ├── index.js                  # Public exports (fetchJobs, registry, applyFilters, etc.)
│   ├── adapters/                 # One file per ATS (greenhouse.js, lever.js, ashby.js)
│   ├── filters.js                # applyFilters — server-side filter logic
│   ├── normalizer.js             # Unified schema mapper
│   ├── registry.js               # Local company catalog (loadRegistry, findAtsBySlug, detectAts)
│   └── cli.js                    # CLI entry point
├── mcp/                          # MCP server (separate npm package)
│   ├── server.js                 # Stdio entry
│   ├── cli.js                    # Dispatcher (server / install / uninstall / help)
│   ├── tools.js                  # Tool registrations
│   ├── resources.js              # Registry Resource
│   ├── descriptions.js           # Tool description strings (the AI surface)
│   ├── envelope.js               # {status, data, metadata} response wrapper
│   ├── errors.js                 # 6-code error taxonomy
│   ├── install.js                # `npx jd-intel-mcp install` auto-configurator
│   └── README.md
├── test/                         # Node built-in test runner
├── registry/                     # JSON catalogs of verified companies per ATS
├── docs/
│   └── filters.md                # Filter design rationale
├── notes/                        # GITIGNORED — private working memory
│   ├── building-mcp.md           # Full journey log, 8 LinkedIn drafts, mental models, decisions
│   ├── expansion-research.md     # Verified next-adapter catalog
│   ├── landing-page-plan.md      # Landing page blueprint
│   └── linkedin-content-guide.md # Content handoff guide
├── README.md                     # Public, dual-audience product page
└── CLAUDE.md                     # This file
```

---

## Key concepts (load these into your head before any change)

**Filter design (the product surface):**
- `titleFilter` matches title only (role identity: PM, engineer, designer)
- `filter` matches title + department + description (topic / scope)
- They AND together. Use both for "PM roles about integrations".
- Location keywords ≤ 4 chars use word-boundary matching (US, UK safe; no Australia / Auckland collisions)
- Prefer include over exclude; avoid bare "Remote" (matches Remote-EMEA etc.)
- Full rationale: `docs/filters.md`

**MCP design choices (already locked):**
- 3 tools (fetch_jobs, search_registry, detect_ats) + 1 Resource (registry)
- Stdio transport; HTTP/Cloudflare Workers version is roadmap (#22 + future)
- Uniform envelope `{status, data, metadata}` across every tool
- 6-code error taxonomy (no `hint` field; tool description teaches recovery)
- Tool names use snake_case for MCP convention; library API uses camelCase

**Registry-first routing:**
- `fetchJobs` consults the registry before probing all adapters
- Known company → 1 adapter call. Unknown → discovery mode (probe all adapters). Workday is registry-only (opaque tenant key, no probe).

**Voice rules (apply to all user-facing prose):**
- No em dashes (—) in README, docs, mcp/README, mcp/descriptions.js. Period, colon, comma, or rewrite. Code comments / JSDoc are exempt.
- No "ChatGPT" references. Use "AI assistants" or "your AI" (platform-neutral).
- Anti-hype tone. Direct, conversational, confident. No buzzwords.
- "PM who builds" — author positioning.
- Kit framing: library + CLI + MCP server are three surfaces of one toolkit. Not "just an API".
- Balance role examples (PM, engineer, designer). Don't pile on PM.
- Keep specific company names spread thin in user-facing prose. Concrete examples are good in code; don't repeat the same 2 companies six times in narrative.

---

## notes/ — raw learning log (gitignored)

This is where decisions, learnings, and mental models go as they happen. Raw, not polished. A separate project consumes from here to produce publishable content (see **Scope** above for the boundary). jd-intel sessions just capture.

**When to write:** the user signals learning ("TIL", "huh", "wait why", "interesting"), a non-obvious design decision is being made, or a mental model is forming. Append a brief entry. No formatting ceremony.

**Where to write:** `notes/building-mcp.md` is the default. Split into a new file only when a topic is big enough to stand alone (the existing expansion-research.md / landing-page-plan.md split is the precedent).

| File | Use for |
|------|---------|
| `notes/building-mcp.md` | Active learning log + journey + mental models. Default file to append to. |
| `notes/expansion-research.md` | Verified catalog of next-adapter options (Recruitee, Personio, Workable, Teamtailor) |
| `notes/landing-page-plan.md` | Landing page blueprint for a focused half-day build |
| `notes/linkedin-content-guide.md` | Read-only from here. The polish/publish project consumes this. |

---

## Skill routing — when to invoke which

This file is mostly a router. Use Claude's defaults plus these targeted skills:

| Task | Skill / approach |
|------|------------------|
| Add a new MCP tool, audit MCP server quality, design tool descriptions | `anthropic-skills:mcp-builder` |
| Write a spec or PRD for a new feature | `product-management:write-spec` |
| Brainstorm product directions, challenge assumptions | `product-management:product-brainstorming` |
| Sprint planning, scoping a focused work session | `product-management:sprint-planning` |
| Synthesize feedback (user testing, reviewer notes) | `product-management:synthesize-research` |
| Design critique on the landing page | `design:design-critique` |
| Write or revise UX copy / microcopy | `design:ux-copy` |
| Accessibility audit on landing page | `design:accessibility-review` |
| Commit, push, open PR | `commit-commands:commit` / `commit-commands:commit-push-pr` |
| Update this file | `claude-md-management:revise-claude-md` |

(Default Claude tooling — Explore agent, Plan agent, general-purpose research — applies as usual; no need to enumerate.)

Default behavior:
- For UI / browser-observable work, follow the preview verification workflow (preview_start, preview_snapshot, etc.). For Node library / MCP server work, the test suite + smoke-test stdin protocol is the verification path.
- Verify before committing. Tests pass. Voice rules applied.
- Don't add comments to code unless WHY is non-obvious.

---

## Where to find current state (live, not snapshot)

For shipped work and current priorities:
- **Live state:** [npm jd-intel](https://www.npmjs.com/package/jd-intel), [npm jd-intel-mcp](https://www.npmjs.com/package/jd-intel-mcp), [GitHub releases](https://github.com/prPMDev/jd-intel/releases)
- **Open priorities:** [GitHub issues](https://github.com/prPMDev/jd-intel/issues) — issues are the source of truth, not this file
- **Parked plans:** `notes/landing-page-plan.md` (landing page), `notes/expansion-research.md` (next-adapter selection)
- **Test baseline:** `node --test test/*.test.js` should be green

---

## Adding a new ATS adapter (the most common contribution path)

- One file at `src/adapters/{name}.js`
- Export `fetch{Name}(slug)` — returns normalized job array (run results through `normalize()` from `src/normalizer.js`)
- Export `has{Name}(slug)` — boolean, HEAD request; used by `detect_ats` for probing
- Register in `src/adapters/index.js` (add to ADAPTERS map and ATS_NAMES array)
- Test fixture at `test/{name}.test.js` using `t.mock.method(global, 'fetch', mockFn)` — fetch mock auto-restores per test, no afterEach needed
- Seed `registry/{name}.json` with verified company entries (`{slug, name, sector}`) — live-verify each entry against the ATS's API before adding
- Verified candidates ready to implement: see `notes/expansion-research.md`

---

## Automated registry expansion (weekly routine)

A scheduled cloud agent expands the registry weekly, staging everything as a PR on a `registry/expansion-YYYY-MM-DD` branch. Rules for ANY agent doing registry data work:

- Candidates file shape: `{ "<ats>": [ {slug, name, sector, config?}, ... ] }` — `config` is Workday-only (`{tenant, env, site}`)
- Gate, then append: `node scripts/verify-registry.mjs --candidates tmp/candidates.json --limit 50`, then `node scripts/append-registry.mjs` (writes `survivorsByAts` from the report; never hand-edit the column-aligned registry JSON)
- Never add an entry that didn't pass the live gate in the same run
- Additions by default. The only permitted change to an existing entry is a migration: it failed on its recorded ATS AND live-verified on another ATS in the same run. Deletions never.
- One company, one ATS — skip candidates whose normalized slug or name (lowercase, alphanumerics only) already exists in any registry file
- After appending: `npm run sync:registry-pages` (the Pages copy must move with `registry/`), then `node --test test/*.test.js`

---

## Standard workflow

1. **Pick a task** from open issues or parked items
2. **Read relevant `notes/*` file** if you need historical context
3. **Plan** with the appropriate skill or Plan agent if non-trivial
4. **Implement** with thin handlers, library does work, tests cover behavior
5. **Verify** — run tests, smoke-test the MCP via stdin if MCP work, voice-review user-facing text
6. **Commit** with a descriptive message, push, mention in issue if applicable

For npm publish flow: token in `.npmrc`, `npm publish` from root for jd-intel, from `mcp/` for jd-intel-mcp. See the publishing log in `notes/building-mcp.md` for the full process documented.

---

## Versioning policy (SemVer)

| Change type | Bump | Examples |
|-------------|------|----------|
| Patch (0.1.0 → 0.1.1) | Bug fixes, doc-only changes, no API changes | Fix Lever salary parser; clarify a tool description |
| Minor (0.1.0 → 0.2.0) | New feature, new adapter, new tool, new filter — backward-compatible | Add Recruitee adapter; add `posted_within_hours` filter |
| Major (0.1.0 → 1.0.0) | Breaking API changes, tool removal, schema changes | Rename `fetch_jobs` to `get_jobs`; remove a field from response |

**When a change affects both packages, bump BOTH `package.json` files (root + `mcp/`) and publish both.** Otherwise bump and publish only the affected one.

After publishing: tag the commit (`git tag v0.X.Y && git push origin v0.X.Y`).

---

## Anti-patterns to watch for

- Adding em dashes back to user-facing prose
- Using ChatGPT-specific language instead of "AI assistants"
- Rebuilding logic the library already exports (use `applyFilters`, `findAtsBySlug`, etc.)
- Writing tool descriptions that don't include USE WHEN / DON'T USE WHEN / argument guidance
- Forgetting to bump version when republishing to npm
- Committing files from `notes/` (they're gitignored for a reason)
- Echoing the npm token in any committed file
- Pile-on of the same 1-2 example companies (Stripe, Mercury) in user-facing prose
- Drafting LinkedIn / blog / course content in this repo. That's the polish-for-publication track, owned by a separate project. Product polish (code, docs, README, MCP descriptions, voice) IS in scope; learning-publication polish isn't.
- Treating `notes/` as read-only. When learning happens, append.
