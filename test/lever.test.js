import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLever, hasLever } from '../src/adapters/lever.js';
import { applyFilters } from '../src/filters.js';
import { disableRetries, isAtsError, probeFailureTests } from './helpers.js';

disableRetries();

/**
 * Lever's API returns a bare array of job objects (no wrapper). Each job has
 * a nested `categories` object for team/department/location, and the posting
 * text is split across `description` (opening + descriptionBody), `lists`
 * (one {text, content} per section) and `additional`.
 *
 * Trimmed from two real postings on the outreach board (2026-09-27), prose
 * shortened. The second posting has no salaryRange; the range in its title
 * was added here to cover the title fallback, since no probed board had one.
 */

const OPENING = '<div><strong style="font-size: 18px;">About Outreach</strong></div>\n<div>&nbsp;</div>\n<div><span style="font-size: 16px;">Outreach, founded in 2014, is the only complete </span><strong><a style="font-size: 16px;" href="https://www.outreach.ai/ai-agents"><u>agentic AI</u></a></strong><span style="font-size: 16px;"> platform for revenue teams.&nbsp; </span></div>';
const OPENING_PLAIN = 'About Outreach\n \nOutreach, founded in 2014, is the only complete agentic AI platform for revenue teams.';

const BODY_1 = '<div>\n<div>\n<h3><span xml:lang="EN-US" data-contrast="auto">About the Team&nbsp;</span></h3>\n</div>\n<div>\n<p><span xml:lang="EN-US" data-contrast="auto">The Customer Advocacy team you would lead is part of the broader Corporate Marketing team.</span></p>\n</div>\n<div>\n<h3><span xml:lang="EN-US" data-contrast="auto">The Role</span></h3>\n</div>\n<div>\n<p><span xml:lang="EN-US" data-contrast="auto">We\'re looking for a dynamic Customer Advocacy Manager to join our corporate marketing team.</span></p>\n</div>\n</div>\n<div>&nbsp;</div>\n<div><strong style="font-size: 16px;">Location:&nbsp;</strong><span style="font-size: 16px;">We&rsquo;re&nbsp;open to remote within the US or hybrid at one of our office locations (Seattle, Atlanta).</span></div>';
const BODY_1_PLAIN = 'About the Team \n\nThe Customer Advocacy team you would lead is part of the broader Corporate Marketing team.\n\nThe Role\n\nWe\'re looking for a dynamic Customer Advocacy Manager to join our corporate marketing team.\n \nLocation: We’re open to remote within the US or hybrid at one of our office locations (Seattle, Atlanta).';

const BODY_2 = '<div>\n<div>\n<h3><span xml:lang="EN" data-contrast="none">About the Team</span><span data-ccp-props="{&quot;201341983&quot;:0}">&nbsp;</span></h3>\n<p><span xml:lang="EN-US" data-contrast="auto">The Solutions Consulting team is an integral part of Outreach&rsquo;s Go-To-Market function.</span></p>\n</div>\n</div>';
const BODY_2_PLAIN = 'About the Team \n\nThe Solutions Consulting team is an integral part of Outreach’s Go-To-Market function.';

const LI_ATTRS = 'aria-setsize="-1" data-leveltext="" data-font="Symbol" data-listid="17" data-list-defn-props="{&quot;335552541&quot;:1,&quot;469769226&quot;:&quot;Symbol&quot;}" data-aria-level="1" role="listitem"';

const FIXTURE = [
  {
    id: '5becd4e1-3474-4f36-b5dd-4b2cd0eb1179',
    text: 'Customer Advocacy Manager',
    hostedUrl: 'https://jobs.lever.co/outreach/5becd4e1-3474-4f36-b5dd-4b2cd0eb1179',
    applyUrl: 'https://jobs.lever.co/outreach/5becd4e1-3474-4f36-b5dd-4b2cd0eb1179/apply',
    createdAt: 1771264785944,
    country: 'US',
    workplaceType: 'remote',
    categories: {
      commitment: 'Full-Time',
      department: 'Marketing',
      location: 'United States',
      team: 'Marketing',
      allLocations: ['United States'],
    },
    opening: OPENING,
    descriptionBody: BODY_1,
    description: OPENING + '<div><br></div>' + BODY_1,
    descriptionPlain: OPENING_PLAIN + '\n\n' + BODY_1_PLAIN,
    lists: [
      {
        text: 'Your Daily Adventures Will Include: ',
        content: '<div>\n\n<li>Run Daily Advocacy Operations: Own the day-to-day operations of the advocacy and reference program.&nbsp;</li>\n<li>Produce Customer Stories: Work directly with customers to capture their success stories.&nbsp;</li>\n\n</div>',
      },
      {
        text: 'Our Vision of You: ',
        content: '<div>\n<div>\n<p><span data-contrast="auto">As you step into this role, you bring with you a sense of enthusiasm and purpose.</span><span data-ccp-props="{}">&nbsp;</span></p>\n</div>\n<div>\n<ul role="list" style="list-style-type: disc;">\n' +
          `<li ${LI_ATTRS} data-aria-posinset="1">\n<p><span data-contrast="auto">5+ years of experience in customer marketing, advocacy, or references within a B2B technology environment</span><span data-ccp-props="{&quot;335559739&quot;:60}">&nbsp;</span></p>\n</li>\n\n</ul></div>\n<div>\n<ul role="list" style="list-style-type: disc;">\n` +
          `<li ${LI_ATTRS} data-aria-posinset="2">\n<p><span data-contrast="auto">Proven experience supporting sales reference and customer advocacy programs</span><span data-ccp-props="{&quot;335559739&quot;:60}">&nbsp;</span></p>\n</li>\n\n</ul></div>\n</div>`,
      },
    ],
    additional: '<div><span style="font-size: 10px;">#LI-AM1</span></div><div><br></div><div><strong style="font-size: 18px;">Why You’ll Love It Here</strong></div>\n<div>&nbsp;</div>\n<div><span style="font-size: 16px;">• Flexible time off </span></div>\n<div><span style="font-size: 16px;">• 401k to help you save for the future</span></div>\n<div>&nbsp;</div>\n<div><span style="font-size: 16px;"><em>Outreach is an equal opportunity employer.</em></span></div>',
    additionalPlain: '#LI-AM1\n\n\nWhy You’ll Love It Here\n \n• Flexible time off \n• 401k to help you save for the future\n \nOutreach is an equal opportunity employer.',
    salaryRange: { max: 110000, currency: 'USD', interval: 'per-year-salary', min: 70000 },
    salaryDescription: '<div><span style="font-size: 11pt;">The annual base salary range for this role is&nbsp;</span><strong style="font-size: 11pt;">$70,000-$110,000 </strong><strong>USD</strong><span style="font-size: 11pt;">. You may also be offered incentive compensation, bonus, restricted stock units, and benefits.</span></div>',
    salaryDescriptionPlain: 'The annual base salary range for this role is $70,000-$110,000 USD. You may also be offered incentive compensation, bonus, restricted stock units, and benefits.',
  },
  {
    id: '37cb8f89-e459-4020-a243-3b08348b418f',
    text: 'Lead Solutions Consultant, EMEA (£85,000 - £105,000)',
    hostedUrl: 'https://jobs.lever.co/outreach/37cb8f89-e459-4020-a243-3b08348b418f',
    applyUrl: 'https://jobs.lever.co/outreach/37cb8f89-e459-4020-a243-3b08348b418f/apply',
    createdAt: 1762794634430,
    country: 'GB',
    workplaceType: 'hybrid',
    categories: {
      commitment: 'Full-Time',
      department: 'Sales',
      location: 'London',
      team: 'Solutions Consultants',
      allLocations: ['London'],
    },
    opening: OPENING,
    descriptionBody: BODY_2,
    description: OPENING + '<div><br></div>' + BODY_2,
    descriptionPlain: OPENING_PLAIN + '\n\n' + BODY_2_PLAIN,
    lists: [
      {
        text: 'Our Vision of You ',
        content: '\n\n<li><strong>Experience:</strong> 7+ years of pre-sales or solution consulting experience, with 3+ years in SaaS enterprise environments.&nbsp;</li>\n<li><strong>Technical &amp; AI Acumen: </strong>Combines strong technical and commercial acumen.&nbsp;</li>\n',
      },
    ],
    additional: '<div>#LI-AM1</div><div><br></div><div><strong style="font-size: 18px;">Why You’ll Love It Here</strong></div>\n<div>&nbsp;</div>\n<div><span style="font-size: 16px;">● 25 days holiday + 8 bank holidays</span></div>',
    additionalPlain: '#LI-AM1\n\n\nWhy You’ll Love It Here\n \n● 25 days holiday + 8 bank holidays',
  },
];

function mockFetch(t, { status = 200, body = FIXTURE } = {}) {
  t.mock.method(global, 'fetch', async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

describe('fetchLever', () => {
  test('hits the correct URL', async (t) => {
    const calls = [];
    t.mock.method(global, 'fetch', async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => FIXTURE };
    });

    await fetchLever('outreach');

    assert.equal(calls.length, 1);
    assert.match(calls[0], /api\.lever\.co\/v0\/postings\/outreach\?mode=json/);
  });

  test('returns [] on 404', async (t) => {
    mockFetch(t, { status: 404, body: {} });
    const jobs = await fetchLever('nonexistent');
    assert.deepEqual(jobs, []);
  });

  test('a 5xx throws ats_unreachable carrying the status', async (t) => {
    mockFetch(t, { status: 500, body: {} });
    await assert.rejects(() => fetchLever('outreach'), isAtsError('ats_unreachable', 500));
  });

  test('returns [] when response is not an array', async (t) => {
    mockFetch(t, { body: { error: 'unexpected shape' } });
    const jobs = await fetchLever('outreach');
    assert.deepEqual(jobs, []);
  });

  test('maps a job to the unified schema', async (t) => {
    mockFetch(t);
    const [job] = await fetchLever('outreach');

    assert.equal(job.title, 'Customer Advocacy Manager');
    assert.equal(job.ats, 'lever');
    assert.equal(job.companySlug, 'outreach');
    assert.equal(job.department, 'Marketing');
    assert.equal(job.location, 'United States');
    assert.equal(job.url, 'https://jobs.lever.co/outreach/5becd4e1-3474-4f36-b5dd-4b2cd0eb1179');
    assert.equal(job.postedAt, '2026-02-16T17:59:45.944Z');
  });

  test('company falls back to titlecased slug, NOT team name', async (t) => {
    // Lever's API doesn't return the company name. Earlier versions used
    // `categories.team` as a fallback, which meant company came back as
    // "Platform" instead of the company. Fix: use slug.
    mockFetch(t);
    const [job] = await fetchLever('outreach');
    assert.equal(job.company, 'Outreach');
    assert.notEqual(job.company, 'Marketing', 'company should NOT be team name');
  });

  test('description carries the intro, every list heading and item, then additional', async (t) => {
    // Lever keeps responsibilities and requirements in `lists`, not in
    // `description`. Without them a skill filter misses the job (#64).
    mockFetch(t);
    const [job] = await fetchLever('outreach');
    const d = job.description;

    assert.match(d, /^About Outreach\n/);
    assert.match(d, /^## About the Team/m);
    assert.match(d, /Location: We’re open to remote within the US/);

    assert.match(d, /## Your Daily Adventures Will Include:\n/);
    assert.match(d, /^- Run Daily Advocacy Operations: Own the day-to-day/m);
    assert.match(d, /^- Produce Customer Stories: Work directly with customers/m);

    assert.match(d, /## Our Vision of You:\n/);
    assert.match(d, /^As you step into this role/m);
    assert.match(d, /^- 5\+ years of experience in customer marketing/m, 'attributed <li> wrapping a <p> is a bullet');
    assert.match(d, /^- Proven experience supporting sales reference/m);

    assert.match(d, /Why You’ll Love It Here\n/);
    assert.match(d, /Outreach is an equal opportunity employer\.$/);

    const order = ['About Outreach', 'The Role', 'Your Daily Adventures', 'Our Vision of You', 'Why You’ll Love It Here']
      .map(s => d.indexOf(s));
    assert.deepEqual([...order].sort((a, b) => a - b), order, 'intro, lists, additional in that order');
  });

  test('description is stripped and decoded once', async (t) => {
    mockFetch(t);
    const [, job] = await fetchLever('outreach');
    assert.doesNotMatch(job.description, /<[a-z]/i);
    assert.doesNotMatch(job.description, /&(?:nbsp|rsquo|amp|quot);/);
    assert.match(job.description, /^- Technical & AI Acumen: Combines strong technical/m);
  });

  test('handles a posting without lists or additional', async (t) => {
    const { lists, additional, additionalPlain, ...bare } = FIXTURE[1];
    mockFetch(t, { body: [bare] });
    const [job] = await fetchLever('outreach');
    assert.match(job.description, /^About Outreach\n/);
    assert.match(job.description, /Go-To-Market function\.$/);
  });

  test('maps salaryRange to the shared salary shape (source ats)', async (t) => {
    mockFetch(t);
    const [job] = await fetchLever('outreach');
    assert.deepEqual(job.salary, { min: 70000, max: 110000, currency: 'USD', period: 'year', source: 'ats' });
  });

  test('maps Lever interval names to period, null when unknown', async (t) => {
    const withRange = (salaryRange) => ({ ...FIXTURE[0], salaryRange });
    mockFetch(t, {
      body: [
        withRange({ min: 45, max: 60, currency: 'USD', interval: 'per-hour-wage' }),
        withRange({ min: 6000, max: 7500, currency: 'EUR', interval: 'per-month-salary' }),
        withRange({ min: 90000, max: 120000, currency: 'CAD', interval: 'flat-fee' }),
      ],
    });
    const [hour, month, unknown] = await fetchLever('outreach');
    assert.equal(hour.salary.period, 'hour');
    assert.equal(month.salary.period, 'month');
    assert.equal(month.salary.currency, 'EUR');
    assert.equal(unknown.salary.period, null);
    assert.equal(unknown.salary.source, 'ats');
  });

  test('keeps a one-sided salaryRange, missing side null', async (t) => {
    mockFetch(t, { body: [{ ...FIXTURE[0], salaryRange: { min: 120000, currency: 'USD', interval: 'per-year-salary' } }] });
    const [job] = await fetchLever('outreach');
    assert.deepEqual(job.salary, { min: 120000, max: null, currency: 'USD', period: 'year', source: 'ats' });
  });

  test('falls back to a range in the title when salaryRange is absent', async (t) => {
    mockFetch(t);
    const [, job] = await fetchLever('outreach');
    assert.deepEqual(job.salary, { min: 85000, max: 105000, currency: 'GBP', period: 'year', source: 'text' });
  });

  test('salary is null when neither salaryRange nor the title states pay', async (t) => {
    mockFetch(t, { body: [{ ...FIXTURE[1], text: 'Lead Solutions Consultant, EMEA' }] });
    const [job] = await fetchLever('outreach');
    assert.equal(job.salary, null);
  });

  test('preserves Lever-specific metadata, including salaryDescription', async (t) => {
    mockFetch(t);
    const [job, second] = await fetchLever('outreach');
    assert.equal(job.metadata.leverId, '5becd4e1-3474-4f36-b5dd-4b2cd0eb1179');
    assert.equal(job.metadata.team, 'Marketing');
    assert.equal(job.metadata.commitment, 'Full-Time');
    assert.equal(job.metadata.workplaceType, 'remote');
    assert.equal(job.metadata.salaryDescription, FIXTURE[0].salaryDescriptionPlain);
    assert.equal(second.metadata.salaryDescription, '');
  });

  test('job ids are unchanged (location still feeds the id, locations does not)', async (t) => {
    mockFetch(t);
    const jobs = await fetchLever('outreach');
    assert.deepEqual(jobs.map(j => j.id), ['baa31bd3717c', 'c321d873f0f1']);
  });

  test('workplaceType wins over a location string with no keyword', async (t) => {
    // "United States" and "London" carry no keyword; the native value is the only signal.
    mockFetch(t);
    const [remote, hybrid] = await fetchLever('outreach');
    assert.equal(remote.locationType, 'remote');
    assert.deepEqual(remote.workplace, { type: 'remote', source: 'ats' });
    assert.equal(hybrid.locationType, 'hybrid');
    assert.deepEqual(hybrid.workplace, { type: 'hybrid', source: 'ats' });
  });

  test('workplaceType onsite maps to onsite; unspecified leaves the text fallback in charge', async (t) => {
    mockFetch(t, { body: [{ ...FIXTURE[1], workplaceType: 'onsite' }, { ...FIXTURE[1], workplaceType: 'unspecified' }] });
    const [onsite, unspecified] = await fetchLever('outreach');
    assert.deepEqual(onsite.workplace, { type: 'onsite', source: 'ats' });
    assert.deepEqual(unspecified.workplace, { type: 'unknown', source: null });
    assert.equal(unspecified.locationType, 'unknown');
  });

  test('locations carries every allLocations entry, primary first, without touching the id', async (t) => {
    const multi = { ...FIXTURE[1], categories: { ...FIXTURE[1].categories, allLocations: ['London', 'Dublin', 'Amsterdam'] } };
    mockFetch(t, { body: [multi] });
    const [job] = await fetchLever('outreach');
    assert.equal(job.location, 'London');
    assert.deepEqual(job.locations, ['London', 'Dublin', 'Amsterdam']);
    assert.equal(job.id, 'c321d873f0f1');
  });

  test('location_includes matches a secondary location', async (t) => {
    const multi = { ...FIXTURE[1], categories: { ...FIXTURE[1].categories, allLocations: ['London', 'Dublin'] } };
    mockFetch(t, { body: [FIXTURE[0], multi] });
    const jobs = await fetchLever('outreach');
    assert.deepEqual(applyFilters(jobs, { locationIncludes: ['Dublin'] }).map(j => j.title), [FIXTURE[1].text]);
    assert.deepEqual(applyFilters(jobs, { locationExcludes: ['London'] }).map(j => j.title).sort(), [FIXTURE[0].text, FIXTURE[1].text].sort(), 'still open in Dublin');
    assert.deepEqual(applyFilters(jobs, { locationExcludes: ['London', 'Dublin'] }).map(j => j.title), [FIXTURE[0].text]);
  });

  test('handles empty array response', async (t) => {
    mockFetch(t, { body: [] });
    const jobs = await fetchLever('empty');
    assert.deepEqual(jobs, []);
  });
});

describe('fetchLever org identity (issue #58)', () => {
  // The postings response names no organization and links only to
  // jobs.lever.co, so the board states nothing about itself.
  test('reports nothing, never the title-cased slug', async (t) => {
    mockFetch(t);
    const reports = [];
    const jobs = await fetchLever('outreach', { report: (r) => reports.push(r) });
    assert.equal(jobs[0].company, 'Outreach', 'the job label keeps its slug fallback');
    assert.deepEqual(reports, []);
  });

  test('a 404 reports nothing', async (t) => {
    mockFetch(t, { status: 404, body: {} });
    const reports = [];
    await fetchLever('nonexistent', { report: (r) => reports.push(r) });
    assert.deepEqual(reports, []);
  });
});

describe('hasLever', () => {
  test('true on a 2xx, probing the postings URL with HEAD', async (t) => {
    const calls = [];
    t.mock.method(global, 'fetch', async (url, init) => {
      calls.push({ url, method: init.method });
      return { ok: true, status: 200 };
    });
    assert.equal(await hasLever('outreach'), true);
    assert.deepEqual(calls, [{ url: 'https://api.lever.co/v0/postings/outreach?mode=json', method: 'HEAD' }]);
  });

  test('false on a 404', async (t) => {
    mockFetch(t, { status: 404, body: {} });
    assert.equal(await hasLever('nonexistent'), false);
  });

  probeFailureTests(hasLever, 'outreach');
});
