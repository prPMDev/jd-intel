# ats-index

**One API to search job listings across Greenhouse, Ashby, and Lever — with full descriptions, not just titles.**

## The problem

Every tech company posts jobs on an ATS (Applicant Tracking System) like Greenhouse, Lever, or Ashby. These platforms have public APIs — but each one works differently, returns different data formats, and requires you to know the exact company slug.

If you want to check what Stripe, Notion, and Linear are hiring for, you'd need to:
1. Figure out that Stripe uses Greenhouse, Notion uses Ashby, Linear uses Ashby
2. Call three different APIs with three different formats
3. Parse three different response structures
4. Get title + URL but no job description from most tools out there

**ats-index does all of this in one call.** One command, full job descriptions, clean format.

## What you get

```bash
npx ats-index fetch stripe
```

```
Found 492 jobs

  Senior Product Manager, Connect [Enterprise] | San Francisco, CA
  https://stripe.com/jobs/search?gh_jid=7532733
  Who we are: Stripe is a financial infrastructure platform for businesses...

  Staff Software Engineer, Payments [Engineering] | Seattle, WA
  https://stripe.com/jobs/search?gh_jid=7218796
  About the team: The Payments team builds the core infrastructure...
```

Full job descriptions in clean markdown — not HTML soup, not just a title and link.

## How it works

```bash
# Fetch jobs from any company — auto-detects which ATS they use
ats-index fetch stripe
ats-index fetch notion
ats-index fetch linear

# Or specify the platform
ats-index fetch stripe --ats greenhouse
ats-index fetch notion --ats ashby

# Find which ATS a company uses
ats-index detect figma

# Search the built-in company registry
ats-index registry search fintech
```

## Use it in your code

```js
import { fetchJobs, registry } from 'ats-index';

const stripeJobs = await fetchJobs({ company: 'stripe' });
// Returns structured job objects with:
// title, company, department, location, salary, description (markdown), url, postedAt

const fintechCompanies = await registry.search('fintech');
// Find companies in the registry by sector
```

## Every job comes with

| Field | Example |
|-------|---------|
| Title | Senior Product Manager, Connect |
| Company | Stripe |
| Department | Enterprise |
| Location | San Francisco, CA |
| Location type | remote / hybrid / onsite |
| Salary | $180,000 - $250,000 (when available) |
| Description | Full JD in clean markdown |
| URL | Direct link to apply |
| Posted date | When available |

## Supported platforms

| Platform | Companies using it | Examples |
|----------|-------------------|----------|
| Greenhouse | 10,000+ | Stripe, Airbnb, Pinterest, Cloudflare, Datadog |
| Ashby | 2,000+ | Notion, Linear, Ramp, Vercel, Anthropic |
| Lever | 5,000+ | Netflix, Shopify, OpenAI, Scale AI |

## Who is this for

- **Job seekers** — search multiple company career pages from one place
- **Developers** — building job search tools, career platforms, or AI agents that need job data
- **Recruiters** — monitoring what competitors are hiring for
- **Researchers** — studying hiring trends across the tech industry

## What's next

- [ ] Track when roles open and close over time
- [ ] `ats-index diff stripe --since 7d` — "Stripe added 12 roles this week"
- [ ] BambooHR and Workday adapters
- [ ] MCP server — let AI assistants query job boards directly
- [ ] Hiring velocity signals — which companies are ramping up or slowing down

## Install

```bash
npm install ats-index
```

Or run directly:

```bash
npx ats-index fetch stripe
```

Requires Node.js 18+. No API keys needed — all endpoints are public.

## License

MIT
