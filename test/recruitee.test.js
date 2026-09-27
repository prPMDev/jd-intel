import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRecruitee } from '../src/adapters/recruitee.js';
import { applyFilters } from '../src/filters.js';

/**
 * Recruitee is a single-call JSON adapter. Mock returns json().
 * t.mock.method auto-restores per test; no afterEach needed.
 *
 * FIXTURE is trimmed from a real /api/offers/ response (2026-09-27). The
 * offer has both HTML fields populated, a structured monthly salary with
 * string amounts, and a `published_at` four months after `created_at`.
 * The salary sentence in `description` is kept so the text fallback has
 * something to find when the structured salary is a placeholder.
 */

const FIXTURE = {
  offers: [
    {
      id: 2548164,
      guid: 'wvrtu',
      title: 'Python Software Engineer - Product team',
      company_name: 'Channable',
      department: 'Engineering',
      city: 'Utrecht',
      country: 'Netherlands',
      remote: false,
      created_at: '2026-03-31 06:40:22 UTC',
      published_at: '2026-07-28 07:21:13 UTC',
      updated_at: '2026-09-22 09:47:29 UTC',
      careers_url: 'https://jobs.channable.com/o/python-software-engineer-product-team-1',
      careers_apply_url: 'https://jobs.channable.com/o/python-software-engineer-product-team-1/c/new',
      salary: { max: '5000', min: '3600', period: 'month', currency: 'EUR' },
      employment_type_code: 'fulltime_permanent',
      category_code: 'engineering',
      description:
        '<h4><span style="color:#121317">What’s in it for you (to start with):</span></h4>' +
        '<ul><li><p><span style="color:#000000">Gross monthly salary ranging from € 3.600 to € 5.000 based on a 40-hour work week.</span></p></li>' +
        '<li><p><span style="color:#000000">8% holiday allowance - 8% of your yearly salary, which is paid together with your May salary.</span></p></li></ul>' +
        '<h4><span style="color:#121317">Your challenges:</span></h4>' +
        '<ul><li><p><span style="color:#000000">Research external eCommerce APIs, understand their value for our customers and build Python integrations with them&nbsp;&nbsp;</span></p></li>' +
        '<li><p><span style="color:#000000">Work with varying technologies, such as strictly typed Python (3.14), SQL, Postgres, GCS, mypy, asyncio, aiohttp, pytest, Sentry, Grafana, Redis and many more!</span></p></li></ul>' +
        '<p style="min-height: 1.7em;"></p>',
      requirements:
        '<h4><span style="color:#121317">The team:</span></h4>' +
        '<p><span style="color:#121317">Google team focuses on Google marketing integrations, including Google Merchant Center (GMC), Comparison Shopping Services (CSS), and large-scale advertising tools.</span></p>' +
        '<h4><span style="color:#121317">More benefits:</span><span style="color:#434343">&nbsp;</span></h4>' +
        '<ul><li><p><span style="color:#000000">Annual L&amp;D budget of €1000 to spend on your professional growth.</span></p></li>' +
        '<li><p><span style="color:#000000">We offer a 3-week-long workcation; and an additional 3 weeks if you live as an expat in the Netherlands!</span></p></li></ul>',
    },
  ],
};

// Recruitee timestamps look like "2026-05-13 07:38:11 UTC".
const daysAgo = (n) =>
  new Date(Date.now() - n * 86400000).toISOString().replace('T', ' ').replace(/\.\d{3}Z$/, ' UTC');

function mockFetch(t, { status = 200, body = FIXTURE } = {}) {
  t.mock.method(global, 'fetch', async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

function withOffer(overrides) {
  return { offers: [{ ...FIXTURE.offers[0], ...overrides }] };
}

describe('fetchRecruitee', () => {
  test('hits the correct URL', async (t) => {
    const calls = [];
    t.mock.method(global, 'fetch', async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => FIXTURE };
    });

    await fetchRecruitee('channable');

    assert.equal(calls.length, 1);
    assert.match(calls[0], /^https:\/\/channable\.recruitee\.com\/api\/offers\/$/);
  });

  test('returns [] on 404 (no Recruitee site)', async (t) => {
    mockFetch(t, { status: 404, body: {} });
    const jobs = await fetchRecruitee('nonexistent');
    assert.deepEqual(jobs, []);
  });

  test('throws on non-404 error', async (t) => {
    mockFetch(t, { status: 500, body: {} });
    await assert.rejects(
      () => fetchRecruitee('channable'),
      /Recruitee API error for channable: 500/
    );
  });

  test('maps an offer to the unified schema', async (t) => {
    mockFetch(t);
    const jobs = await fetchRecruitee('channable');

    assert.equal(jobs.length, 1);
    const job = jobs[0];

    assert.equal(job.title, 'Python Software Engineer - Product team');
    assert.equal(job.company, 'Channable');
    assert.equal(job.companySlug, 'channable');
    assert.equal(job.ats, 'recruitee');
    assert.equal(job.department, 'Engineering');
    assert.equal(job.location, 'Utrecht, Netherlands');
    assert.equal(job.url, 'https://jobs.channable.com/o/python-software-engineer-product-team-1');
    assert.equal(job.metadata.recruiteeId, 'wvrtu');
    assert.equal(job.metadata.employmentType, 'fulltime_permanent');
  });

  test('description joins the description and requirements HTML, description first', async (t) => {
    mockFetch(t);
    const [job] = await fetchRecruitee('channable');

    const challenges = job.description.indexOf('## Your challenges:');
    const team = job.description.indexOf('## The team:');
    assert.ok(challenges >= 0, 'description text is present');
    assert.ok(team > challenges, 'requirements text follows description text');
    assert.match(job.description, /- Annual L&D budget of €1000/);
    assert.doesNotMatch(job.description, /<\/?(?:h4|ul|li|p|span)\b/);
  });

  test('offers without requirements are unchanged', async (t) => {
    for (const requirements of ['', null, undefined]) {
      mockFetch(t, { body: withOffer({ requirements }) });
      const [job] = await fetchRecruitee('channable');
      assert.match(job.description, /^## What’s in it for you/);
      assert.match(job.description, /Redis and many more!$/);
      assert.doesNotMatch(job.description, /Merchant Center/);
    }
  });

  test('filter matches a term that appears only in requirements', async (t) => {
    mockFetch(t);
    const jobs = await fetchRecruitee('channable');
    assert.equal(applyFilters(jobs, { filter: 'workcation' }).length, 1);
    assert.equal(applyFilters(jobs, { filter: 'asyncio' }).length, 1);

    mockFetch(t, { body: withOffer({ requirements: '' }) });
    const without = await fetchRecruitee('channable');
    assert.equal(applyFilters(without, { filter: 'workcation' }).length, 0);
  });

  test('strips HTML once: attributed <li> bullets and escaped text survive', async (t) => {
    mockFetch(t, {
      body: withOffer({ description: '<ul><li class="req">C++ and &lt;5 years</li><li>Dutch is a plus</li></ul>', requirements: '' }),
    });
    const [job] = await fetchRecruitee('channable');
    assert.equal(job.description, '- C++ and <5 years\n- Dutch is a plus');
  });

  test('postedAt is published_at, not created_at, and created_at is kept in metadata', async (t) => {
    mockFetch(t);
    const [job] = await fetchRecruitee('channable');
    assert.equal(job.postedAt, '2026-07-28T07:21:13.000Z');
    assert.equal(job.metadata.createdAt, '2026-03-31T06:40:22.000Z');
    assert.notEqual(job.postedAt, job.metadata.createdAt);
  });

  test('postedAt falls back to created_at when published_at is missing', async (t) => {
    for (const published_at of ['', null, undefined]) {
      mockFetch(t, { body: withOffer({ published_at }) });
      const [job] = await fetchRecruitee('channable');
      assert.equal(job.postedAt, '2026-03-31T06:40:22.000Z');
    }
  });

  test('posted_within_days keeps an old offer that was published this week', async (t) => {
    mockFetch(t, { body: withOffer({ created_at: daysAgo(400), published_at: daysAgo(2) }) });
    const jobs = await fetchRecruitee('channable');
    assert.equal(applyFilters(jobs, { postedWithinDays: 7 }).length, 1);
  });

  test('maps a structured monthly salary with its currency and period', async (t) => {
    mockFetch(t);
    const [job] = await fetchRecruitee('channable');
    assert.deepEqual(job.salary, { min: 3600, max: 5000, currency: 'EUR', period: 'month', source: 'ats' });
  });

  test('maps an hourly salary with only min to max: null', async (t) => {
    // Shape as a Dutch board returns it for a part-time role.
    mockFetch(t, { body: withOffer({ salary: { max: null, min: '15.75', period: 'hour', currency: 'EUR' } }) });
    const [job] = await fetchRecruitee('channable');
    assert.deepEqual(job.salary, { min: 15.75, max: null, currency: 'EUR', period: 'hour', source: 'ats' });
  });

  test('a placeholder or missing salary falls back to the posting text', async (t) => {
    const shapes = [
      { max: '0', min: '0', period: 'month', currency: 'DKK' },
      { max: null, min: null, period: null, currency: null },
      { max: null, min: null, period: 'year', currency: 'EUR' },
      undefined,
    ];
    for (const salary of shapes) {
      mockFetch(t, { body: withOffer({ salary }) });
      const [job] = await fetchRecruitee('channable');
      assert.deepEqual(job.salary, { min: 3600, max: 5000, currency: 'EUR', period: 'month', source: 'text' }, JSON.stringify(salary));
    }
  });

  test('salary is null when neither the ATS nor the text states pay', async (t) => {
    mockFetch(t, {
      body: withOffer({
        salary: { max: '0', min: '0', period: 'month', currency: 'DKK' },
        description: '<p>Competitive package.</p>',
        requirements: '',
      }),
    });
    const [job] = await fetchRecruitee('channable');
    assert.equal(job.salary, null);
  });

  test('an unknown period maps to null', async (t) => {
    mockFetch(t, { body: withOffer({ salary: { max: '800', min: '600', period: 'week', currency: 'EUR' } }) });
    const [job] = await fetchRecruitee('channable');
    assert.deepEqual(job.salary, { min: 600, max: 800, currency: 'EUR', period: null, source: 'ats' });
  });

  test('prefixes remote locations', async (t) => {
    mockFetch(t, { body: withOffer({ remote: true }) });
    const [job] = await fetchRecruitee('channable');
    assert.equal(job.location, 'Remote - Utrecht, Netherlands');
    assert.equal(job.locationType, 'remote');
  });

  test('handles empty offers array', async (t) => {
    mockFetch(t, { body: { offers: [] } });
    const jobs = await fetchRecruitee('emptyco');
    assert.deepEqual(jobs, []);
  });
});
