# ats-index

**One API to search job listings across Greenhouse, Ashby, and Lever: full descriptions, not just titles.**

## The problem

Companies post jobs on ATS (Applicant Tracking System) platforms like Greenhouse, Lever, or Ashby. These platforms have public APIs, but each one works differently, returns different data, and requires you to know the exact company identifier.

If you want to check what three different companies are hiring for, you need to:
1. Figure out which ATS each company uses
2. Call three different APIs with three different formats
3. Parse three different response structures
4. Get title + URL but no job description from most tools out there

**ats-index does all of this in one call.** One command, full job descriptions, clean format.

## What you get

```bash
npx ats-index fetch <company-slug>
```

```
Found 47 jobs

  Senior Product Manager [Product] | San Francisco, CA
  https://boards.greenhouse.io/example/jobs/123456
  About the role: You will own the product roadmap for our integrations platform...

  Staff Software Engineer [Engineering] | Remote
  https://boards.greenhouse.io/example/jobs/789012
  About the team: We build the core infrastructure that powers...
```

Full job descriptions in clean markdown. Not HTML soup. Not just a title and link.

## How it works

```bash
# Fetch jobs from any company: auto-detects which ATS they use
ats-index fetch <company-slug>

# Specify the platform
ats-index fetch <company-slug> --ats greenhouse
ats-index fetch <company-slug> --ats ashby

# Find which ATS a company uses
ats-index detect <company-name>

# Search the built-in company registry
ats-index registry search fintech
```

## Use it in your code

```js
import { fetchJobs, registry } from 'ats-index';

const jobs = await fetchJobs({ company: 'company-slug' });
// Returns structured job objects with:
// title, company, department, location, salary, description (markdown), url, postedAt

const companies = await registry.search('fintech');
// Find companies in the registry by sector
```

## Every job comes with

| Field | What you get |
|-------|-------------|
| Title | Full job title with team/department |
| Company | Normalized company name |
| Department | When available from the ATS |
| Location | City, state, country |
| Location type | remote / hybrid / onsite |
| Salary | Min-max range when the company provides it |
| Description | Full job description in clean markdown |
| URL | Direct link to the posting |
| Posted date | When available |

## Supported platforms

| Platform | What it covers |
|----------|---------------|
| Greenhouse | The most widely used ATS in tech. Public board API with full JDs. |
| Ashby | Popular with startups. REST + GraphQL APIs, often includes compensation. |
| Lever | Common in mid-stage companies. JSON API with department and workplace data. |

## Who is this for

**Job seekers:** Connect this to your AI assistant to search company career pages without visiting each one manually. Pair with evaluation tools to score and track opportunities against your profile.

**Developers:** Building a job search tool, career platform, or AI agent that needs structured job data? Use this as your data layer instead of writing your own ATS adapters.

**Researchers:** Studying hiring trends, labor markets, or company growth patterns? We are open to ideas: open an issue and tell us what data would be useful.

## What's next

- [ ] Track when roles close or reopen over time
- [ ] Show what changed at a company since your last check
- [ ] BambooHR and Workday adapters
- [ ] MCP server: let AI assistants query job boards as a tool

## Install

```bash
npm install ats-index
```

Or run directly:

```bash
npx ats-index fetch <company-slug>
```

Requires Node.js 18+. No API keys needed: all endpoints are public.

## Contributing

The company registry ships with a curated list of tech companies. To add companies, submit a PR to the files in `registry/`. Format:

```json
{"slug": "company-slug", "name": "Company Name", "sector": "industry"}
```

## License

MIT
