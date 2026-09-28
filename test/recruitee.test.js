import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRecruitee, hasRecruitee } from '../src/adapters/recruitee.js';
import { applyFilters } from '../src/filters.js';
import { disableRetries, isAtsError, probeFailureTests } from './helpers.js';

disableRetries();

/**
 * Recruitee is a single-call JSON adapter. Mock returns json().
 * t.mock.method auto-restores per test; no afterEach needed.
 *
 * FIXTURE is trimmed from a real /api/offers/ response (2026-09-27). The
 * offer has both HTML fields populated, a structured monthly salary with
 * string amounts, and a `published_at` four months after `created_at`.
 * The salary sentence in `description` is kept so the text fallback has
 * something to find when the structured salary is a placeholder. The
 * arrangement is three booleans (`remote`, `hybrid`, `on_site`) and the
 * offices are `locations[]`; the live offer is hybrid in one office.
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
      hybrid: true,
      on_site: false,
      locations: [
        { id: 64463, name: 'Utrecht', state: 'Utrecht', country: 'Netherlands', city: 'Utrecht', country_code: 'NL', state_code: 'UT', postal_code: '3512 HL', street: 'Kromme Nieuwegracht 66', note: null },
      ],
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

// A second office as the same API returns it on a remote offer at the same board.
const NYC_LOCATION = { id: 64457, name: 'New York City', state: 'New York', country: 'United States', city: 'New York City', country_code: 'US', state_code: 'NY', postal_code: '10168', street: '122 East 42nd Street, Suite 1708', note: null };

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

  test('a 5xx throws ats_unreachable carrying the status', async (t) => {
    mockFetch(t, { status: 500, body: {} });
    await assert.rejects(() => fetchRecruitee('channable'), isAtsError('ats_unreachable', 500));
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
    mockFetch(t, { body: withOffer({ remote: true, hybrid: false }) });
    const [job] = await fetchRecruitee('channable');
    assert.equal(job.location, 'Remote - Utrecht, Netherlands');
    assert.equal(job.locationType, 'remote');
    assert.deepEqual(job.workplace, { type: 'remote', source: 'ats' });
    assert.deepEqual(job.locations, ['Remote - Utrecht, Netherlands', 'Utrecht, Netherlands']);
  });

  test('hybrid: true maps to hybrid with source ats and no prefix on the location', async (t) => {
    mockFetch(t);
    const [job] = await fetchRecruitee('channable');
    assert.equal(job.location, 'Utrecht, Netherlands');
    assert.equal(job.locationType, 'hybrid');
    assert.deepEqual(job.workplace, { type: 'hybrid', source: 'ats' });
  });

  test('hybrid wins when remote is also set', async (t) => {
    mockFetch(t, { body: withOffer({ remote: true, hybrid: true }) });
    const [job] = await fetchRecruitee('channable');
    assert.deepEqual(job.workplace, { type: 'hybrid', source: 'ats' });
  });

  test('on_site alone is onsite; no flag set leaves the type unknown', async (t) => {
    mockFetch(t, { body: withOffer({ remote: false, hybrid: false, on_site: true }) });
    assert.deepEqual((await fetchRecruitee('channable'))[0].workplace, { type: 'onsite', source: 'ats' });

    mockFetch(t, { body: withOffer({ remote: false, hybrid: false, on_site: false }) });
    const [job] = await fetchRecruitee('channable');
    assert.deepEqual(job.workplace, { type: 'unknown', source: null });
    assert.equal(job.locationType, 'unknown');
  });

  test('locations lists every locations[] office, primary first, without touching the id', async (t) => {
    mockFetch(t, { body: withOffer({ locations: [...FIXTURE.offers[0].locations, NYC_LOCATION] }) });
    const [job] = await fetchRecruitee('channable');
    assert.equal(job.location, 'Utrecht, Netherlands');
    assert.deepEqual(job.locations, ['Utrecht, Netherlands', 'New York City, United States']);
    assert.equal(job.id, '6fc152a43cc7');
  });

  test('location_includes matches a secondary office; excludes drop only when every office matches', async (t) => {
    mockFetch(t, { body: withOffer({ locations: [...FIXTURE.offers[0].locations, NYC_LOCATION] }) });
    const jobs = await fetchRecruitee('channable');
    assert.equal(applyFilters(jobs, { locationIncludes: ['United States'] }).length, 1);
    assert.equal(applyFilters(jobs, { locationIncludes: ['New York'] }).length, 1);
    assert.equal(applyFilters(jobs, { locationIncludes: ['Germany'] }).length, 0);
    assert.equal(applyFilters(jobs, { locationExcludes: ['Netherlands'] }).length, 1, 'still open in New York');
    assert.equal(applyFilters(jobs, { locationExcludes: ['Netherlands', 'United States'] }).length, 0);
  });

  test('job id is unchanged (location still feeds the id, locations does not)', async (t) => {
    mockFetch(t);
    const [job] = await fetchRecruitee('channable');
    assert.equal(job.id, '6fc152a43cc7');
  });

  test('handles empty offers array', async (t) => {
    mockFetch(t, { body: { offers: [] } });
    const jobs = await fetchRecruitee('emptyco');
    assert.deepEqual(jobs, []);
  });
});

describe('fetchRecruitee org identity (issue #58)', () => {
  // The response is { offers } only. Each offer carries company_name and a
  // careers_url on the site's own careers domain when it has one.
  const report = (reports) => (r) => reports.push(r);

  test('reports company_name and the careers_url host', async (t) => {
    mockFetch(t);
    const reports = [];
    await fetchRecruitee('channable', { report: report(reports) });
    assert.deepEqual(reports, [{ ats: 'recruitee', org_name: 'Channable', org_url: 'jobs.channable.com' }]);
  });

  test('a careers_url on the recruitee.com host yields org_url null', async (t) => {
    mockFetch(t, { body: withOffer({ careers_url: 'https://channable.recruitee.com/o/python-software-engineer-product-team-1' }) });
    const reports = [];
    await fetchRecruitee('channable', { report: report(reports) });
    assert.deepEqual(reports, [{ ats: 'recruitee', org_name: 'Channable', org_url: null }]);
  });

  test('an empty board reports null and null, not the slug', async (t) => {
    mockFetch(t, { body: { offers: [] } });
    const reports = [];
    await fetchRecruitee('emptyco', { report: report(reports) });
    assert.deepEqual(reports, [{ ats: 'recruitee', org_name: null, org_url: null }]);
  });

  test('a 404 reports nothing', async (t) => {
    mockFetch(t, { status: 404, body: {} });
    const reports = [];
    await fetchRecruitee('nonexistent', { report: report(reports) });
    assert.deepEqual(reports, []);
  });
});

describe('hasRecruitee', () => {
  test('true on a 2xx from the offers endpoint', async (t) => {
    const calls = [];
    t.mock.method(global, 'fetch', async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => FIXTURE };
    });
    assert.equal(await hasRecruitee('channable'), true);
    assert.deepEqual(calls, ['https://channable.recruitee.com/api/offers/']);
  });

  test('false on a 404', async (t) => {
    mockFetch(t, { status: 404, body: {} });
    assert.equal(await hasRecruitee('nonexistent'), false);
  });

  probeFailureTests(hasRecruitee, 'channable');
});
