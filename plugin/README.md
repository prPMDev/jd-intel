# jd-intel

Your AI searches open jobs across 1,000+ verified companies on nine hiring platforms (Greenhouse, Lever, Ashby, SmartRecruiters, Teamtailor, Recruitee, Personio, Workable, Workday) and reads the full postings. No copy-paste, no browsing job boards one at a time.

## Use it

Ask in plain language: "Which fintech companies in the registry are hiring product managers in the US?" or "What is open at a specific company for senior engineers, posted this month?" Claude searches the company registry, fetches live postings, filters by title, topic, location and age, and reads the full job descriptions to tell you which roles fit you.

Three tools: `fetch_jobs` (one company's open roles with filters and paging), `search_registry` (find companies by name or sector) and `detect_ats` (which platforms a company hires on). All three only read.

## Data

The plugin starts the `jd-intel-mcp` server on your machine with `npx`. The server calls the hiring platforms' public job-board APIs directly from your computer and fetches the company registry from `https://prpmdev.github.io/jd-intel/registry/`. It stores nothing, keeps no account, and sends your questions to no server of ours. Requests go only to the platform that hosts the board you asked about and to that GitHub Pages registry.

Runs in Claude Code and in Cowork sessions on your computer. Needs Node.js 18.20 or newer for `npx`.

Source, docs and issues: https://github.com/prPMDev/jd-intel
