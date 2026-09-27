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
    assert.deepEqual(job.salary, { min: 196000, max: 294000, currency: 'USD' });
  });

  test('preserves departments and offices in metadata', async (t) => {
    mockFetch(t);
    const [job] = await fetchGreenhouse('vercel');
    assert.deepEqual(job.metadata.departments, ['Engineering']);
    assert.deepEqual(job.metadata.offices, ['AMER']);
    assert.equal(job.metadata.greenhouseId, 5179639004);
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
