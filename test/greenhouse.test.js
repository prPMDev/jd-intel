import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchGreenhouse } from '../src/adapters/greenhouse.js';
import { applyFilters } from '../src/filters.js';

/**
 * Why we mock fetch in adapter tests:
 *   - Real API calls are slow (hundreds of ms each)
 *   - They depend on the company still existing + still posting jobs
 *   - They fail offline, in CI, and when Greenhouse rate-limits
 *
 * Node 22's fetch is a global, so we override it per-test using
 * t.mock.method(). It auto-restores after the test. No afterEach needed.
 *
 * FIXTURE is trimmed from a real /jobs?content=true response (2026-09-27).
 * Top-level keys are `jobs` and `meta` only; there is no `name`. Greenhouse
 * returns `content` HTML-entity-encoded, and the fixture keeps it that way.
 * The second job has `first_published` removed to cover the fallback.
 */

const FIXTURE = {
  jobs: [
    {
      absolute_url: 'https://job-boards.greenhouse.io/vercel/jobs/5179639004',
      internal_job_id: 4697743004,
      location: { name: 'Hybrid - San Francisco, New York City' },
      id: 5179639004,
      updated_at: '2026-09-24T14:51:08-04:00',
      requisition_id: '573',
      title: 'Software Engineer, CDN',
      company_name: 'Vercel',
      first_published: '2024-05-28T11:00:05-04:00',
      language: 'en',
      content: '&lt;h2&gt;About Vercel:&lt;/h2&gt;\n&lt;p&gt;The San Francisco, CA base pay range for this role is $196,000-$294,000. Actual salary will be based on job-related skills, experience, and location.&lt;/p&gt;',
      departments: [{ id: 4042495004, name: 'Engineering', child_ids: [], parent_id: null }],
      offices: [{ id: 4014159004, name: 'AMER', location: 'Remote - AMER', child_ids: [4035429004, 4035428004], parent_id: null }],
    },
    {
      absolute_url: 'https://job-boards.greenhouse.io/vercel/jobs/6129441004',
      internal_job_id: 5193154004,
      location: { name: 'Remote - United States' },
      id: 6129441004,
      updated_at: '2026-09-24T13:19:48-04:00',
      requisition_id: '1303',
      title: 'Design Engineer',
      company_name: 'Vercel',
      language: 'en',
      content: '&lt;h2&gt;About Vercel:&lt;/h2&gt;\n&lt;p&gt;&lt;span data-sheets-root=&quot;1&quot;&gt;The San Francisco, CA base pay range for this role is $208,000 - $312,000. Actual salary will be based on job-related skills, experience, and location.&lt;/p&gt;',
      departments: [{ id: 4063261004, name: 'Design', child_ids: [], parent_id: null }],
      offices: [{ id: 4091065004, name: 'Office - San Francisco', location: 'San Francisco, California, United States', child_ids: [], parent_id: 4014159004 }],
    },
  ],
  meta: { total: 2 },
};

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

/**
 * Trimmed from a live board response (issue #66). Greenhouse escapes the
 * whole `content` string, so tags arrive as &lt;p&gt;, quotes as &quot;,
 * apostrophes as &#39;, and the author's own entities double-encoded
 * (&amp;mdash;, &amp;lt;). The pay transparency block is Greenhouse's own
 * markup: title div, pay-range div, spans with a divider between them.
 */
const ESCAPED_FIXTURE = {
  jobs: [
    {
      id: 4000000001,
      internal_job_id: 4000000001,
      title: 'Enterprise Account Executive',
      updated_at: '2026-07-22T05:37:08-04:00',
      absolute_url: 'https://boards.greenhouse.io/testco/jobs/4000000001?gh_jid=4000000001',
      location: { name: 'San Francisco, CA • New York, NY • United States' },
      departments: [{ name: 'Sales' }],
      offices: [{ name: 'US' }],
      content:
        '&lt;div class=&quot;content-intro&quot;&gt;&lt;p&gt;We build tools for teams. If you&#39;re excited to shape the future of collaboration, join us!&lt;/p&gt;&lt;/div&gt;' +
        '&lt;h4&gt;&lt;strong&gt;What you&#39;ll do:&lt;/strong&gt;&lt;/h4&gt;\n' +
        '&lt;ul&gt;\n' +
        '&lt;li&gt;Own services written in C++ and Python&lt;/li&gt;\n' +
        '&lt;li&gt;Build relationships with key decision-makers in enterprise accounts (5000+ FTEs)&lt;/li&gt;\n' +
        '&lt;/ul&gt;\n' +
        '&lt;p&gt;You bring 8+ years of experience and &amp;lt;5 years in your current role.&lt;/p&gt;\n' +
        '&lt;div&gt;&lt;div&gt;&lt;div class=&quot;description&quot;&gt;&lt;p&gt;Pay ranges are set by location and level.&lt;/p&gt;&lt;/div&gt;' +
        '&lt;div class=&quot;title&quot;&gt;Annual Base Salary Range:&lt;/div&gt;' +
        '&lt;div class=&quot;pay-range&quot;&gt;&lt;span&gt;$165,000&lt;/span&gt;&lt;span class=&quot;divider&quot;&gt;&amp;mdash;&lt;/span&gt;&lt;span&gt;$190,000 USD&lt;/span&gt;&lt;/div&gt;' +
        '&lt;/div&gt;&lt;/div&gt;' +
        '&lt;div class=&quot;content-conclusion&quot;&gt;&lt;p&gt;We are an &lt;a href=&quot;https://example.com/eeo&quot;&gt;equal opportunity workplace&lt;/a&gt;. ' +
        'Applications are processed under our &lt;a class=&quot;c-link&quot; href=&quot;https://example.com/privacy&quot; target=&quot;_blank&quot;&gt;Candidate Privacy Notice&lt;/a&gt;.&lt;/p&gt;&lt;/div&gt;',
    },
  ],
};

function mockFetch(t, { status = 200, body = FIXTURE } = {}) {
  t.mock.method(global, 'fetch', async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

describe('fetchGreenhouse', () => {
  test('hits the correct URL', async (t) => {
    const calls = [];
    t.mock.method(global, 'fetch', async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => FIXTURE };
    });

    await fetchGreenhouse('vercel');

    assert.equal(calls.length, 1);
    assert.match(calls[0], /boards-api\.greenhouse\.io\/v1\/boards\/vercel\/jobs\?content=true/);
  });

  test('returns [] on 404 (company not found)', async (t) => {
    mockFetch(t, { status: 404, body: {} });
    const jobs = await fetchGreenhouse('nonexistent');
    assert.deepEqual(jobs, []);
  });

  test('throws on non-404 error', async (t) => {
    mockFetch(t, { status: 500, body: {} });
    await assert.rejects(
      () => fetchGreenhouse('vercel'),
      /Greenhouse API error for vercel: 500/
    );
  });

  test('maps a job to the unified schema', async (t) => {
    mockFetch(t);
    const jobs = await fetchGreenhouse('vercel');

    assert.equal(jobs.length, 2);
    const job = jobs[0];

    assert.equal(job.title, 'Software Engineer, CDN');
    // /jobs carries no top-level name, so company falls back to the slug (#58)
    assert.equal(job.company, 'vercel');
    assert.equal(job.companySlug, 'vercel');
    assert.equal(job.ats, 'greenhouse');
    assert.equal(job.department, 'Engineering');
    assert.equal(job.location, 'Hybrid - San Francisco, New York City');
    assert.equal(job.locationType, 'hybrid');
    assert.equal(job.url, 'https://job-boards.greenhouse.io/vercel/jobs/5179639004');
  });

  test('postedAt is first_published, not updated_at', async (t) => {
    mockFetch(t);
    const [job] = await fetchGreenhouse('vercel');
    assert.equal(job.postedAt, '2024-05-28T11:00:05-04:00');
    assert.notEqual(job.postedAt, job.metadata.updatedAt);
  });

  test('postedAt falls back to updated_at when first_published is missing', async (t) => {
    mockFetch(t);
    const [, job] = await fetchGreenhouse('vercel');
    assert.equal(job.postedAt, '2026-09-24T13:19:48-04:00');
  });

  test('metadata.updatedAt carries the raw updated_at', async (t) => {
    mockFetch(t);
    const [cdn, design] = await fetchGreenhouse('vercel');
    assert.equal(cdn.metadata.updatedAt, '2026-09-24T14:51:08-04:00');
    assert.equal(design.metadata.updatedAt, '2026-09-24T13:19:48-04:00');
  });

  test('extracts salary from description text', async (t) => {
    mockFetch(t);
    const [job] = await fetchGreenhouse('vercel');
    assert.deepEqual(job.salary, { min: 196000, max: 294000, currency: 'USD', period: 'year', source: 'text' });
  });

  test('preserves departments and offices in metadata', async (t) => {
    mockFetch(t);
    const [job] = await fetchGreenhouse('vercel');
    assert.deepEqual(job.metadata.departments, ['Engineering']);
    assert.deepEqual(job.metadata.offices, ['AMER']);
    assert.equal(job.metadata.greenhouseId, 5179639004);
  });

  test('job ids are unchanged (location still feeds the id, locations does not)', async (t) => {
    mockFetch(t);
    const jobs = await fetchGreenhouse('vercel');
    assert.deepEqual(jobs.map(j => j.id), ['7cd973622506', '666025dbd8ff']);
  });

  test('handles empty jobs array', async (t) => {
    mockFetch(t, { body: { jobs: [], meta: { total: 0 } } });
    const jobs = await fetchGreenhouse('emptyco');
    assert.deepEqual(jobs, []);
  });

  test('postedWithinDays: 7 keeps a new posting and drops an old one with a fresh updated_at', async (t) => {
    const [cdn, design] = FIXTURE.jobs;
    mockFetch(t, {
      body: {
        jobs: [
          { ...cdn, first_published: daysAgo(365), updated_at: daysAgo(1) },
          { ...design, first_published: daysAgo(2), updated_at: daysAgo(1) },
        ],
        meta: { total: 2 },
      },
    });

    const jobs = await fetchGreenhouse('vercel');
    const recent = applyFilters(jobs, { postedWithinDays: 7 });

    assert.equal(recent.length, 1);
    assert.equal(recent[0].title, 'Design Engineer');
  });
});

describe('fetchGreenhouse workplace from a board custom field (issue #68)', () => {
  // Greenhouse's per-job `metadata[]` carries board-defined custom fields as
  // { id, name, value, value_type }. `value` is a string for single_select
  // and an array for multi_select. The names and values below are the ones
  // seen on boards that track workplace this way.
  const field = (name, value, value_type = 'single_select') => ({ id: 4000000123, name, value, value_type });
  const [cdn, design] = FIXTURE.jobs;
  const withJobs = (...jobs) => ({ jobs, meta: { total: jobs.length } });

  test('with no such field the location string is the only signal, marked as text', async (t) => {
    mockFetch(t, { body: withJobs({ ...cdn, metadata: [field('Career Site Categories', 'Engineering')] }, design) });
    const [hybrid, remote] = await fetchGreenhouse('vercel');
    assert.deepEqual(hybrid.workplace, { type: 'hybrid', source: 'text' });
    assert.deepEqual(remote.workplace, { type: 'remote', source: 'text' });
    assert.deepEqual(hybrid.locations, ['Hybrid - San Francisco, New York City']);
  });

  test('a Location Type or Workplace Type field wins over the location string', async (t) => {
    mockFetch(t, {
      body: withJobs(
        { ...cdn, location: { name: 'Remote-Friendly - San Francisco, CA' }, metadata: [field('Location Type', 'On-Site')] },
        { ...design, location: { name: 'United States' }, metadata: [field('Workplace Type', 'Remote')] },
        { ...design, location: { name: 'New York City, NY' }, metadata: [field('Location Type', 'Hybrid (Travel-Required)')] },
        { ...design, location: { name: 'Austin, TX' }, metadata: [field('Workplace Type', ['Remote'], 'multi_select')] },
      ),
    });
    const [onsite, remote, hybrid, multiSelect] = await fetchGreenhouse('vercel');
    assert.equal(onsite.locationType, 'onsite');
    assert.deepEqual(onsite.workplace, { type: 'onsite', source: 'ats' });
    assert.deepEqual(remote.workplace, { type: 'remote', source: 'ats' });
    assert.deepEqual(hybrid.workplace, { type: 'hybrid', source: 'ats' });
    assert.deepEqual(multiSelect.workplace, { type: 'remote', source: 'ats' });
  });

  test('an unrecognized or empty field value leaves the text fallback in charge', async (t) => {
    mockFetch(t, {
      body: withJobs(
        { ...design, location: { name: 'Austin, TX' }, metadata: [field('Location Type', 'Flexible')] },
        { ...design, location: { name: 'Austin, TX' }, metadata: [field('Location Type', null)] },
        { ...design, location: { name: 'Remote - United States' }, metadata: [field('Location Type', null)] },
      ),
    });
    const [flexible, empty, remoteText] = await fetchGreenhouse('vercel');
    assert.deepEqual(flexible.workplace, { type: 'unknown', source: null });
    assert.equal(flexible.locationType, 'unknown');
    assert.deepEqual(empty.workplace, { type: 'unknown', source: null });
    assert.deepEqual(remoteText.workplace, { type: 'remote', source: 'text' });
  });
});

describe('fetchGreenhouse with HTML-escaped content (issue #66)', () => {
  test('keeps C++, apostrophes and a real dash', async (t) => {
    mockFetch(t, { body: ESCAPED_FIXTURE });
    const [job] = await fetchGreenhouse('testco');
    assert.match(job.description, /C\+\+ and Python/);
    assert.match(job.description, /you're excited/);
    assert.match(job.description, /What you'll do:/);
    assert.match(job.description, /8\+ years of experience/);
    assert.match(job.description, /\$165,000—\$190,000 USD/);
  });

  test('keeps text the author escaped on purpose (&amp;lt;5 years -> <5 years)', async (t) => {
    mockFetch(t, { body: ESCAPED_FIXTURE });
    const [job] = await fetchGreenhouse('testco');
    assert.match(job.description, /<5 years in your current role/);
  });

  test('parses the pay transparency range', async (t) => {
    mockFetch(t, { body: ESCAPED_FIXTURE });
    const [job] = await fetchGreenhouse('testco');
    assert.deepEqual(job.salary, { min: 165000, max: 190000, currency: 'USD', period: 'year', source: 'text' });
  });

  test('breaks blocks so the pay range and the next paragraph do not run together', async (t) => {
    mockFetch(t, { body: ESCAPED_FIXTURE });
    const [job] = await fetchGreenhouse('testco');
    assert.match(job.description, /Annual Base Salary Range:\n\$165,000/);
    assert.match(job.description, /\$190,000 USD\n/);
    assert.doesNotMatch(job.description, /USDWe/);
  });

  test('renders headings and bullets, leaves no tags or literal entities', async (t) => {
    mockFetch(t, { body: ESCAPED_FIXTURE });
    const [job] = await fetchGreenhouse('testco');
    assert.match(job.description, /^## What you'll do:/m);
    assert.match(job.description, /^- Own services written in C\+\+ and Python$/m);
    assert.doesNotMatch(job.description, /<(?:p|div|span|a|li|ul|h4|strong)\b/);
    assert.doesNotMatch(job.description, /&(?:mdash|lt|gt|quot|amp|#\d+);/);
  });
});
