import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { fetchJobs, fetchJobsDetailed } from '../src/index.js';

// Force the on-disk registry so the global fetch mocks below only intercept
// adapter calls, never the (now network-first) registry load. Route the disk
// loader at the fixture registry so routing assertions are independent of
// live registry content (companies migrate ATS; tests must not care).
process.env.JD_INTEL_REGISTRY_URL = '';
process.env.JD_INTEL_REGISTRY_DIR = fileURLToPath(new URL('./fixtures/registry', import.meta.url));

/**
 * fetchJobs routing: explicit-ATS config passthrough (Workday reachable
 * without a registry entry), registry fallback on the explicit path,
 * config-over-registry precedence, and canonical-cased slug routing for
 * case-sensitive registries (SmartRecruiters). Mocks global fetch
 * (auto-restored per test by t.mock.method).
 */

const WD_LIST = {
  total: 1,
  jobPostings: [
    { title: 'Product Manager', externalPath: '/job/Remote/PM_R1', locationsText: 'Remote', postedOn: 'Posted Today' },
  ],
};
const WD_DETAIL = { jobPostingInfo: { jobDescription: '<p>Build.</p>', startDate: '2026-05-01', location: 'Remote' } };

function workdayMock(t) {
  const calls = { urls: [] };
  t.mock.method(global, 'fetch', async (url) => {
    calls.urls.push(String(url));
    if (String(url).endsWith('/jobs')) return { ok: true, status: 200, json: async () => WD_LIST };
    return { ok: true, status: 200, json: async () => WD_DETAIL };
  });
  return calls;
}

describe('fetchJobs — Workday config passthrough', () => {
  test('explicit ats=workday + config reaches the adapter with that triple', async (t) => {
    const calls = workdayMock(t);
    const jobs = await fetchJobs({
      company: 'expedia',
      ats: 'workday',
      config: { tenant: 'expedia', env: 'wd108', site: 'search' },
    });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].title, 'Product Manager');
    assert.ok(
      calls.urls.includes('https://expedia.wd108.myworkdayjobs.com/wday/cxs/expedia/search/jobs'),
      `expected the passthrough triple in the list URL, got: ${calls.urls[0]}`
    );
  });

  test('explicit ats=workday with NO config falls back to registry config', async (t) => {
    const calls = workdayMock(t);
    const jobs = await fetchJobs({ company: 'fixtureco', ats: 'workday' });
    assert.equal(jobs.length, 1);
    assert.ok(
      calls.urls.includes('https://fixtureco.wd0.myworkdayjobs.com/wday/cxs/fixtureco/FixtureCareers/jobs'),
      `expected registry-fallback triple, got: ${calls.urls[0]}`
    );
  });

  test('explicit config overrides the registry entry', async (t) => {
    const calls = workdayMock(t);
    await fetchJobs({
      company: 'fixtureco',
      ats: 'workday',
      config: { tenant: 'override', env: 'wd99', site: 'OverrideSite' },
    });
    assert.ok(
      calls.urls.some(u => u.startsWith('https://override.wd99.myworkdayjobs.com/')),
      `expected explicit config to win, got: ${calls.urls[0]}`
    );
    assert.ok(
      !calls.urls.some(u => u.includes('fixtureco.wd0')),
      'registry config must not be used when explicit config is given'
    );
  });
});

describe('fetchJobsDetailed — order, offset and total_matched', () => {
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  // Board order is old, new, undated, older; newest-first is new, old, older, undated.
  const GH_BOARD = {
    jobs: [
      { id: 1, title: 'Old Role', absolute_url: 'https://gh.example/1', content: 'a', first_published: daysAgo(10), location: { name: 'Remote' } },
      { id: 2, title: 'New Role', absolute_url: 'https://gh.example/2', content: 'b', first_published: daysAgo(2), location: { name: 'Remote' } },
      { id: 3, title: 'Undated Role', absolute_url: 'https://gh.example/3', content: 'c', location: { name: 'Remote' } },
      { id: 4, title: 'Older Role', absolute_url: 'https://gh.example/4', content: 'd', first_published: daysAgo(40), location: { name: 'Remote' } },
    ],
  };

  function greenhouseMock(t) {
    t.mock.method(global, 'fetch', async () => ({ ok: true, status: 200, json: async () => GH_BOARD }));
  }

  test('returns { jobs, total_matched } with the page sorted newest first', async (t) => {
    greenhouseMock(t);
    const { jobs, total_matched } = await fetchJobsDetailed({ company: 'fixture-gh', limit: 2 });
    assert.equal(total_matched, 4);
    assert.deepEqual(jobs.map(j => j.title), ['New Role', 'Old Role']);
  });

  test('offset pages the sorted set; fetchJobs returns the same page as an array', async (t) => {
    greenhouseMock(t);
    const second = await fetchJobsDetailed({ company: 'fixture-gh', limit: 2, offset: 2 });
    assert.equal(second.total_matched, 4);
    assert.deepEqual(second.jobs.map(j => j.title), ['Older Role', 'Undated Role']);
    const asArray = await fetchJobs({ company: 'fixture-gh', limit: 2, offset: 2 });
    assert.deepEqual(asArray.map(j => j.title), ['Older Role', 'Undated Role']);
  });

  test("order: 'board' keeps the adapter's order", async (t) => {
    greenhouseMock(t);
    const { jobs } = await fetchJobsDetailed({ company: 'fixture-gh', order: 'board' });
    assert.deepEqual(jobs.map(j => j.title), ['Old Role', 'New Role', 'Undated Role', 'Older Role']);
  });

  test('offset reaches the Workday adapter as part of its hydrate budget', async (t) => {
    const list = {
      total: 3,
      jobPostings: [1, 2, 3].map(i => ({ title: `Role ${i}`, externalPath: `/job/Remote/R${i}`, locationsText: 'Remote', postedOn: 'Posted Today' })),
    };
    let detailCalls = 0;
    t.mock.method(global, 'fetch', async (url) => {
      if (String(url).endsWith('/jobs')) return { ok: true, status: 200, json: async () => list };
      detailCalls += 1;
      return { ok: true, status: 200, json: async () => WD_DETAIL };
    });
    const { jobs } = await fetchJobsDetailed({ company: 'fixtureco', ats: 'workday', offset: 1, limit: 1 });
    // offset 1 + limit 1 hydrates two postings, not one; the page is the second.
    assert.equal(detailCalls, 2);
    assert.equal(jobs.length, 1);
  });
});

describe('fetchJobs — Workday multi-location rows reach the post-detail location filter (issue #68)', () => {
  const list = {
    total: 2,
    jobPostings: [
      { title: 'Staff Engineer', externalPath: '/job/Vancouver/Staff-Engineer_R7', locationsText: '2 Locations', postedOn: 'Posted Today' },
      { title: 'Account Manager', externalPath: '/job/Galway/Account-Manager_R8', locationsText: 'Galway, Ireland', postedOn: 'Posted Today' },
    ],
  };
  const detail = {
    jobPostingInfo: {
      jobDescription: '<p>Build.</p>',
      startDate: '2026-09-19',
      location: 'Vancouver, British Columbia, Canada',
      additionalLocations: ['Austin, Texas, United States of America'],
      remoteType: 'Remote',
    },
  };

  test('location_includes on a secondary location returns the job, with one detail fetch', async (t) => {
    let detailCalls = 0;
    t.mock.method(global, 'fetch', async (url) => {
      if (String(url).endsWith('/jobs')) return { ok: true, status: 200, json: async () => list };
      detailCalls += 1;
      return { ok: true, status: 200, json: async () => detail };
    });
    const jobs = await fetchJobs({ company: 'fixtureco', ats: 'workday', locationIncludes: ['United States'] });
    assert.equal(detailCalls, 1, 'the "2 Locations" row is hydrated, Galway is not');
    assert.deepEqual(jobs.map(j => j.title), ['Staff Engineer']);
    assert.deepEqual(jobs[0].locations, ['Vancouver, British Columbia, Canada', 'Austin, Texas, United States of America']);
    assert.deepEqual(jobs[0].workplace, { type: 'remote', source: 'ats' });
  });

  test('the post-detail pass still drops it when no listed location matches', async (t) => {
    t.mock.method(global, 'fetch', async (url) => {
      if (String(url).endsWith('/jobs')) return { ok: true, status: 200, json: async () => list };
      return { ok: true, status: 200, json: async () => detail };
    });
    const jobs = await fetchJobs({ company: 'fixtureco', ats: 'workday', locationIncludes: ['Germany'] });
    assert.deepEqual(jobs, []);
  });
});

describe('fetchJobs — canonical-cased registry slug routing', () => {
  test('auto-detect routes a PascalCase SmartRecruiters slug from lowercased input', async (t) => {
    const calls = { urls: [] };
    t.mock.method(global, 'fetch', async (url) => {
      calls.urls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ content: [], totalFound: 0 }) };
    });
    const jobs = await fetchJobs({ company: 'acmepay' }); // no ats -> registry-routed
    assert.deepEqual(jobs, []);
    // Routed via the registry to a single adapter using the canonical
    // 'AcmePay' (not lowercased 'acmepay', not 7-adapter discovery probing).
    assert.ok(
      calls.urls.length > 0 && calls.urls.every(u => u.includes('api.smartrecruiters.com')),
      `expected only SmartRecruiters calls (registry-routed), got: ${calls.urls.join(', ')}`
    );
    assert.ok(
      calls.urls.some(u => u.includes('/v1/companies/AcmePay/postings')),
      `expected canonical 'AcmePay' in the URL, got: ${calls.urls[0]}`
    );
  });
});

describe('fetchJobs — the same location filters give the same set on a Workday board and a Greenhouse board (issue #61)', () => {
  // Identical postings on both boards. "us" sits inside Australia, Brussels,
  // Austin and Houston, "uk" inside Ukraine, "in" inside Berlin and Austin;
  // only San Francisco and London carry US or UK as a word.
  const POSTINGS = [
    ['Account Executive', 'Sydney, Australia'],
    ['Solutions Engineer', 'Brussels, Belgium'],
    ['Software Engineer', 'Kyiv, Ukraine'],
    ['Product Designer', 'Austin, TX'],
    ['Data Analyst', 'Houston, TX'],
    ['Product Manager', 'Berlin, Germany'],
    ['Staff Engineer', 'San Francisco, US'],
    ['Account Manager', 'London, UK'],
  ];
  const WD_ROWS = POSTINGS.map(([title, location], i) => ({
    title,
    externalPath: `/job/${location.replace(/[^A-Za-z]+/g, '-')}/${title.replace(/ /g, '-')}_R${i}`,
    locationsText: location,
    postedOn: 'Posted Today',
  }));
  const GH_BOARD = {
    jobs: POSTINGS.map(([title, location], i) => ({
      id: i, title, absolute_url: `https://gh.example/${i}`, content: 'Build.', first_published: '2026-09-20T00:00:00Z', location: { name: location },
    })),
  };

  function bothBoards(t) {
    const calls = { detail: 0 };
    t.mock.method(global, 'fetch', async (url) => {
      const u = String(url);
      if (u.includes('greenhouse.io')) return { ok: true, status: 200, json: async () => GH_BOARD };
      if (u.endsWith('/jobs')) return { ok: true, status: 200, json: async () => ({ total: WD_ROWS.length, jobPostings: WD_ROWS }) };
      calls.detail += 1;
      const row = WD_ROWS.find(p => u.endsWith(p.externalPath));
      return { ok: true, status: 200, json: async () => ({ jobPostingInfo: { jobDescription: '<p>Build.</p>', startDate: '2026-09-20', location: row.locationsText } }) };
    });
    return calls;
  }

  const ALL = POSTINGS.map(([, location]) => location);
  const CASES = [
    [{ locationExcludes: ['US'] }, ALL.filter(l => l !== 'San Francisco, US')],
    [{ locationIncludes: ['US'] }, ['San Francisco, US']],
    [{ locationIncludes: ['United States', 'US', 'Remote - US'] }, ['San Francisco, US']],
    [{ locationExcludes: ['IN'] }, ALL],
    [{ locationIncludes: ['UK'] }, ['London, UK']],
    [{ locationIncludes: [' uk '] }, ['London, UK']],
    [{ locationExcludes: [''] }, ALL],
    [{ locationExcludes: [' '] }, ALL],
  ];

  for (const [filters, expected] of CASES) {
    test(JSON.stringify(filters), async (t) => {
      const calls = bothBoards(t);
      const workday = await fetchJobs({ company: 'fixtureco', order: 'board', ...filters });
      const greenhouse = await fetchJobs({ company: 'fixture-gh', order: 'board', ...filters });
      assert.deepEqual(workday.map(j => j.location), expected);
      assert.deepEqual(greenhouse.map(j => j.location), expected);
      assert.equal(calls.detail, expected.length, 'Workday hydrates exactly the rows the shared matcher keeps');
    });
  }
});
