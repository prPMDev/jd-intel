import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { fetchJobs, fetchJobsDetailed, ArgumentError } from '../src/index.js';
import { ADAPTERS } from '../src/adapters/index.js';
import { normalize } from '../src/normalizer.js';
import { disableRetries, isAtsError, mockFetchByHost, okResponse, statusResponse } from './helpers.js';

// Force the on-disk registry so the global fetch mocks below only intercept
// adapter calls, never the (now network-first) registry load. Route the disk
// loader at the fixture registry so routing assertions are independent of
// live registry content (companies migrate ATS; tests must not care).
process.env.JD_INTEL_REGISTRY_URL = '';
process.env.JD_INTEL_REGISTRY_DIR = fileURLToPath(new URL('./fixtures/registry', import.meta.url));

disableRetries();

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

describe('fetchJobsDetailed — match, company, boards and failed (issues #55, #58, #60)', () => {
  const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const ghBoard = (titles, age = 2) => ({
    jobs: titles.map((title, i) => ({
      id: i + 1, title, absolute_url: `https://gh.example/${i + 1}`, content: 'Build.', first_published: daysAgo(age), location: { name: 'Remote' },
    })),
  });
  const ashbyBoard = (titles, age = 30) => ({
    jobs: titles.map((title, i) => ({ id: `a${i + 1}`, title, location: 'Remote', publishedAt: daysAgo(age), descriptionHtml: '<p>Build.</p>' })),
  });
  const GH = 'greenhouse.io';
  const LEVER = 'lever.co';
  const ASHBY = 'ashbyhq.com';

  test('registry hit: one board with jobs_found and matched, company from the row, nothing failed', async (t) => {
    const calls = mockFetchByHost(t, { [GH]: okResponse(ghBoard(['Product Manager', 'Staff Engineer'])) });
    const result = await fetchJobsDetailed({ company: 'fixture-gh', titleFilter: 'manager' });
    assert.equal(result.match, 'registry');
    assert.deepEqual(result.company, { key: 'fixturegreenhouseco', name: 'Fixture Greenhouse Co' });
    assert.deepEqual(result.boards, [{
      ats: 'greenhouse',
      slug: 'fixture-gh',
      name: 'Fixture Greenhouse Co',
      site: null,
      board_url: 'https://boards.greenhouse.io/fixture-gh',
      org_name: null,
      org_url: null,
      jobs_found: 2,
      matched: 1,
      selected: true,
      scan: null,
    }]);
    assert.deepEqual(result.failed, []);
    assert.equal(result.total_before_filters, 2);
    assert.equal(result.total_matched, 1);
    assert.deepEqual(result.jobs.map(j => j.title), ['Product Manager']);
    assert.equal(calls.length, 1, 'a registry hit costs one adapter call');
  });

  test('registry hit: the adapter AtsError still propagates', async (t) => {
    mockFetchByHost(t, { [GH]: statusResponse(503) });
    await assert.rejects(fetchJobsDetailed({ company: 'fixture-gh' }), isAtsError('ats_unreachable', 503));
  });

  test('explicit ats with the company in the registry on that ATS is a registry match with the row config', async (t) => {
    workdayMock(t);
    const result = await fetchJobsDetailed({ company: 'fixtureco', ats: 'workday' });
    assert.equal(result.match, 'registry');
    assert.deepEqual(result.company, { key: 'fixtureworkdayco', name: 'Fixture Workday Co' });
    assert.equal(result.boards[0].site, 'FixtureCareers');
    assert.equal(result.boards[0].board_url, 'https://fixtureco.wd0.myworkdayjobs.com/FixtureCareers');
  });

  test('explicit ats without a registry row is a probe: listed when it answers, absent when it 404s', async (t) => {
    mockFetchByHost(t, { [GH]: okResponse(ghBoard(['Designer'])) });
    const hit = await fetchJobsDetailed({ company: 'nocorp', ats: 'greenhouse' });
    assert.equal(hit.match, 'probe');
    assert.equal(hit.company, null);
    assert.deepEqual(hit.boards.map(b => [b.ats, b.slug, b.name, b.jobs_found]), [['greenhouse', 'nocorp', null, 1]]);

    mockFetchByHost(t, {});
    const miss = await fetchJobsDetailed({ company: 'nocorp', ats: 'greenhouse' });
    assert.deepEqual(miss.boards, []);
    assert.deepEqual(miss.failed, []);
  });

  test('discovery: one adapter answers, another is rate limited; both are reported', async (t) => {
    mockFetchByHost(t, { [GH]: okResponse(ghBoard(['Product Manager'])), [LEVER]: statusResponse(429) });
    const result = await fetchJobsDetailed({ company: 'nocorp' });
    assert.equal(result.match, 'probe');
    assert.equal(result.company, null);
    assert.deepEqual(result.boards.map(b => [b.ats, b.slug, b.name, b.jobs_found, b.matched]), [['greenhouse', 'nocorp', null, 1, 1]]);
    assert.equal(result.failed.length, 1);
    const [failure] = result.failed;
    assert.equal(failure.ats, 'lever');
    assert.equal(failure.slug, 'nocorp');
    assert.equal(failure.name, null);
    assert.equal(failure.code, 'rate_limited');
    assert.match(failure.message, /429/);
    assert.deepEqual(Object.keys(failure).sort(), ['ats', 'code', 'message', 'name', 'slug'], 'the shape #87 fixes, nothing extra');
    // A board answered, so the array form still returns the page.
    assert.deepEqual((await fetchJobs({ company: 'nocorp' })).map(j => j.title), ['Product Manager']);
  });

  test('discovery: every adapter 404 is the true not-found: no boards, no failures', async (t) => {
    mockFetchByHost(t, {});
    const result = await fetchJobsDetailed({ company: 'nocorp' });
    assert.equal(result.match, 'probe');
    assert.deepEqual(result.boards, []);
    assert.deepEqual(result.failed, []);
    assert.equal(result.total_before_filters, 0);
    assert.equal(result.total_matched, 0);
    assert.deepEqual(await fetchJobs({ company: 'nocorp' }), []);
  });

  test('discovery: a live board whose rows all miss the title filter still shows up, with total_before_filters above zero', async (t) => {
    mockFetchByHost(t, { [GH]: okResponse(ghBoard(['Account Executive', 'Sales Lead', 'Recruiter'])) });
    const result = await fetchJobsDetailed({ company: 'nocorp', titleFilter: 'product designer' });
    assert.deepEqual(result.jobs, []);
    assert.equal(result.total_matched, 0);
    assert.equal(result.total_before_filters, 3);
    assert.deepEqual(result.boards.map(b => [b.ats, b.jobs_found, b.matched]), [['greenhouse', 3, 0]]);
  });

  test('discovery: zero boards and one 429: the detailed call returns the object, the array call throws rate_limited', async (t) => {
    mockFetchByHost(t, { [LEVER]: statusResponse(429) });
    const result = await fetchJobsDetailed({ company: 'nocorp' });
    assert.deepEqual(result.jobs, []);
    assert.deepEqual(result.boards, []);
    assert.deepEqual(result.failed.map(f => [f.ats, f.code]), [['lever', 'rate_limited']]);

    await assert.rejects(fetchJobs({ company: 'nocorp' }), (err) => {
      isAtsError('rate_limited', 429)(err);
      assert.match(err.message, /lever/);
      assert.match(err.message, /nocorp/);
      return true;
    });
  });

  test('discovery: zero boards and only a 503 throws ats_unreachable from the array call', async (t) => {
    mockFetchByHost(t, { [ASHBY]: statusResponse(503) });
    await assert.rejects(fetchJobs({ company: 'nocorp' }), (err) => {
      isAtsError('ats_unreachable', undefined)(err);
      assert.match(err.message, /ashby/);
      return true;
    });
  });

  test('Workday override: one board from the config, listed even when it returns no rows', async (t) => {
    workdayMock(t);
    const config = { tenant: 'expedia', env: 'wd108', site: 'search' };
    const result = await fetchJobsDetailed({ company: 'expedia', ats: 'workday', config });
    assert.equal(result.match, 'workday_override');
    assert.equal(result.company, null);
    assert.deepEqual(result.boards.map(b => [b.ats, b.slug, b.name, b.site, b.board_url, b.jobs_found, b.matched]), [
      ['workday', 'expedia', null, 'search', 'https://expedia.wd108.myworkdayjobs.com/search', 1, 1],
    ]);

    t.mock.method(global, 'fetch', async () => okResponse({ total: 0, jobPostings: [] }));
    const empty = await fetchJobsDetailed({ company: 'expedia', ats: 'workday', config });
    assert.equal(empty.boards.length, 1);
    assert.equal(empty.boards[0].jobs_found, 0);
    assert.equal(empty.total_before_filters, 0);
  });

  test('matched is counted per board before the page cut, so a board the limit removed entirely still reports its count', async (t) => {
    mockFetchByHost(t, {
      [GH]: okResponse(ghBoard(['New Role A', 'New Role B'], 1)),
      [ASHBY]: okResponse(ashbyBoard(['Old Role C', 'Old Role D'], 30)),
    });
    const result = await fetchJobsDetailed({ company: 'nocorp', limit: 2 });
    assert.deepEqual(result.jobs.map(j => j.ats), ['greenhouse', 'greenhouse']);
    assert.equal(result.total_matched, 4);
    assert.equal(result.total_before_filters, 4);
    assert.deepEqual(result.boards.map(b => [b.ats, b.jobs_found, b.matched]), [['greenhouse', 2, 2], ['ashby', 2, 2]]);
  });

  test("a filter that removes one board's rows leaves that board with matched 0 and the other unchanged", async (t) => {
    mockFetchByHost(t, {
      [GH]: okResponse(ghBoard(['Product Manager', 'Staff Engineer'])),
      [ASHBY]: okResponse(ashbyBoard(['Designer'])),
    });
    const result = await fetchJobsDetailed({ company: 'nocorp', titleFilter: 'engineer|manager' });
    assert.deepEqual(result.boards.map(b => [b.ats, b.jobs_found, b.matched]), [['greenhouse', 2, 2], ['ashby', 1, 0]]);
    assert.equal(result.total_matched, 2);
    assert.equal(result.total_before_filters, 3);
  });
});

describe("fetchJobsDetailed — ctx.report records a board's scan, and jobs_found is the list it reports (issue #60)", () => {
  // Workday and SmartRecruiters filter their list before hydrating, so the
  // rows they return are already a filter result. Both report the scan
  // through ctx.report and jobs_found takes `listed` from it, so a filter
  // miss on a hiring company reads as hiring on every ATS. Real adapters,
  // mocked fetch.
  const WD = 'myworkdayjobs.com';
  const SR = 'api.smartrecruiters.com';
  const wdList = (titles) => ({
    total: titles.length,
    jobPostings: titles.map((title, i) => ({ title, externalPath: `/job/Remote/R${i}`, locationsText: 'Remote', postedOn: 'Posted Today' })),
  });
  const workdayRoutes = (titles) => ({ [WD]: (u) => okResponse(u.endsWith('/jobs') ? wdList(titles) : WD_DETAIL) });
  const srList = (titles) => ({
    totalFound: titles.length,
    content: titles.map((name, i) => ({ id: `${i + 1}`, name, releasedDate: '2026-09-01T00:00:00Z', location: { city: 'Berlin', country: 'Germany' } })),
  });
  const SR_DETAIL = { jobAd: { sections: { jobDescription: { text: 'Build.' } } }, postingUrl: 'https://jobs.smartrecruiters.com/x' };
  const srRoutes = (titles) => ({ [SR]: (u) => okResponse(/\/postings\/[^/?]+$/.test(u) ? SR_DETAIL : srList(titles)) });
  const MISS = 'product designer';
  const SALES = ['Account Executive', 'Sales Lead', 'Recruiter'];

  test('Workday registry hit with a title filter that misses: jobs_found is the list, nothing hydrated', async (t) => {
    const calls = mockFetchByHost(t, workdayRoutes(SALES));
    const result = await fetchJobsDetailed({ company: 'fixtureco', titleFilter: MISS });
    assert.equal(result.match, 'registry');
    assert.deepEqual(result.jobs, []);
    assert.equal(result.total_matched, 0);
    assert.equal(result.total_before_filters, 3);
    assert.deepEqual(result.boards.map(b => [b.ats, b.jobs_found, b.matched, b.scan]), [
      ['workday', 3, 0, { listed: 3, prefiltered: 0, hydrated: 0, capped: false }],
    ]);
    assert.equal(calls.length, 1, 'the list request only; no detail to fetch');
  });

  test('the same Workday company with an empty list reads jobs_found 0: not hiring is a different answer from a filter miss', async (t) => {
    mockFetchByHost(t, workdayRoutes([]));
    const result = await fetchJobsDetailed({ company: 'fixtureco', titleFilter: MISS });
    assert.deepEqual(result.boards.map(b => [b.jobs_found, b.matched, b.scan.listed]), [[0, 0, 0]]);
    assert.equal(result.total_before_filters, 0);
  });

  test('Workday: limit cuts the hydrate budget, not jobs_found', async (t) => {
    mockFetchByHost(t, workdayRoutes(['Role 1', 'Role 2', 'Role 3', 'Role 4', 'Role 5']));
    const result = await fetchJobsDetailed({ company: 'fixtureco', limit: 2 });
    assert.equal(result.jobs.length, 2);
    assert.equal(result.total_before_filters, 5);
    assert.deepEqual(result.boards.map(b => [b.jobs_found, b.matched, b.scan]), [
      [5, 2, { listed: 5, prefiltered: 5, hydrated: 2, capped: true }],
    ]);
  });

  test('SmartRecruiters registry hit with a title filter that misses reads the same way, on the canonical slug', async (t) => {
    const calls = mockFetchByHost(t, srRoutes(SALES));
    const result = await fetchJobsDetailed({ company: 'acmepay', titleFilter: MISS });
    assert.equal(result.match, 'registry');
    assert.equal(result.total_matched, 0);
    assert.equal(result.total_before_filters, 3);
    assert.deepEqual(result.boards.map(b => [b.ats, b.slug, b.jobs_found, b.matched, b.scan]), [
      ['smartrecruiters', 'AcmePay', 3, 0, { listed: 3, prefiltered: 0, hydrated: 0, capped: false }],
    ]);
    assert.equal(calls.length, 1, 'the list request only');
  });

  test('in discovery, a SmartRecruiters board whose pre-filter dropped every row is still a board, counted from its list', async (t) => {
    mockFetchByHost(t, srRoutes(['Account Executive', 'Recruiter']));
    const result = await fetchJobsDetailed({ company: 'nocorp', titleFilter: 'zzz' });
    assert.equal(result.match, 'probe');
    assert.deepEqual(result.boards.map(b => [b.ats, b.jobs_found, b.matched, b.scan.listed]), [['smartrecruiters', 2, 0, 2]]);
    assert.equal(result.total_before_filters, 2);
    assert.deepEqual(result.failed, []);
  });

  test('the adapter receives companyName, filterContext and report; a report without listed falls back to the rows', async (t) => {
    // A stub through the ADAPTERS map, restored after the test: the one way
    // to see the ctx object itself.
    let ctxSeen;
    t.mock.method(ADAPTERS.smartrecruiters, 'fetch', async (slug, ctx) => {
      ctxSeen = ctx;
      ctx.report({ ats: 'smartrecruiters', prefiltered: 6, hydrated: 6, capped: false });
      return ['Product Manager', 'Group PM'].map(title =>
        normalize({ companySlug: slug, company: slug, title, location: 'Remote', description: 'Build.', url: `https://x/${title}` }, 'smartrecruiters'));
    });
    const result = await fetchJobsDetailed({ company: 'acmepay', titleFilter: 'product', limit: 20, offset: 5 });
    assert.deepEqual(result.boards[0].scan, { listed: undefined, prefiltered: 6, hydrated: 6, capped: false });
    assert.equal(result.boards[0].jobs_found, 2);
    assert.equal(result.boards[0].matched, 1);
    assert.equal(ctxSeen.companyName, 'AcmePay');
    assert.equal(ctxSeen.filterContext.titleFilter, 'product');
    assert.equal(ctxSeen.filterContext.limit, 20);
    assert.equal(ctxSeen.filterContext.offset, 5);
  });

  test('content_missing counts unread postings before the filters drop them (issue #85)', async (t) => {
    const job = (title, extra) => normalize({ companySlug: 'AcmePay', company: 'AcmePay', title, location: 'Remote', url: `https://x/${title}`, ...extra }, 'smartrecruiters');
    t.mock.method(ADAPTERS.smartrecruiters, 'fetch', async () => [
      job('Read PM', { description: 'Build the platform.' }),
      job('Unread PM', { content: { status: 'missing', reason: 'http_503' } }),
    ]);
    const all = await fetchJobsDetailed({ company: 'acmepay' });
    assert.deepEqual([all.jobs.length, all.content_missing], [2, 1]);
    const filtered = await fetchJobsDetailed({ company: 'acmepay', filter: 'platform' });
    assert.deepEqual(filtered.jobs.map(j => j.title), ['Read PM']);
    assert.equal(filtered.content_missing, 1, 'the unread job is counted though the filter could not match it');
  });

  test('a board that reports no counts has scan null and jobs_found from its rows', async (t) => {
    mockFetchByHost(t, { 'greenhouse.io': okResponse({ jobs: [{ id: 1, title: 'PM', absolute_url: 'https://x/1', content: 'a', location: { name: 'Remote' } }] }) });
    const result = await fetchJobsDetailed({ company: 'nocorp' });
    assert.equal(result.boards[0].scan, null);
    assert.equal(result.boards[0].jobs_found, 1);
  });
});

describe('fetchJobsDetailed — boards[].org_name and org_url come from the board itself (issue #58)', () => {
  const GH = 'greenhouse.io';
  const LEVER = 'lever.co';
  const SR = 'api.smartrecruiters.com';
  const ghRows = (company_name) => okResponse({
    jobs: [{ id: 1, title: 'Product Manager', absolute_url: 'https://job-boards.greenhouse.io/nocorp/jobs/1', content: 'Build.', location: { name: 'Remote' }, company_name }],
  });
  const leverRows = okResponse([{ id: 'l1', text: 'Designer', hostedUrl: 'https://jobs.lever.co/nocorp/l1', description: 'Design.', categories: { location: 'Remote' } }]);
  const SR_DETAIL = { jobAd: { sections: { jobDescription: { text: 'Build.' } } }, postingUrl: 'https://jobs.smartrecruiters.com/AcmePay/1' };
  const srList = okResponse({
    totalFound: 1,
    content: [{ id: '1', name: 'Product Manager', company: { identifier: 'AcmePay', name: 'AcmePay Ltd' }, releasedDate: '2026-09-01T00:00:00Z', location: { city: 'Berlin', country: 'Germany' } }],
  });
  const orgOf = (b) => [b.ats, b.org_name, b.org_url];

  test('discovery: a Greenhouse board names itself, a Lever board cannot; neither reports counts', async (t) => {
    mockFetchByHost(t, { [GH]: ghRows('Nocorp Labs'), [LEVER]: leverRows });
    const { boards } = await fetchJobsDetailed({ company: 'nocorp' });
    assert.deepEqual(boards.map(orgOf), [['greenhouse', 'Nocorp Labs', null], ['lever', null, null]]);
    assert.deepEqual(boards.map(b => b.scan), [null, null]);
    assert.deepEqual(boards.map(b => b.name), [null, null], 'no registry name to borrow from on a probe');
  });

  test('a registry hit keeps the registry name and the board name apart', async (t) => {
    mockFetchByHost(t, { [GH]: ghRows('Fixture Greenhouse Co. (Board)') });
    const { company, boards } = await fetchJobsDetailed({ company: 'fixture-gh' });
    assert.equal(company.name, 'Fixture Greenhouse Co');
    assert.equal(boards[0].name, 'Fixture Greenhouse Co');
    assert.equal(boards[0].org_name, 'Fixture Greenhouse Co. (Board)');

    mockFetchByHost(t, { [GH]: ghRows(undefined) });
    const silent = await fetchJobsDetailed({ company: 'fixture-gh' });
    assert.equal(silent.boards[0].name, 'Fixture Greenhouse Co');
    assert.equal(silent.boards[0].org_name, null, 'a board that says nothing is not filled from the registry');
  });

  test('a report with counts and org fields splits: scan keeps the four counts, the board keeps the org', async (t) => {
    mockFetchByHost(t, { [SR]: (u) => (/\/postings\/[^/?]+$/.test(u) ? okResponse(SR_DETAIL) : srList) });
    const { boards } = await fetchJobsDetailed({ company: 'acmepay' });
    const [board] = boards;
    assert.deepEqual(board.scan, { listed: 1, prefiltered: 1, hydrated: 1, capped: false });
    assert.deepEqual(orgOf(board), ['smartrecruiters', 'AcmePay Ltd', null]);
    assert.ok(!('ats' in board.scan) && !('org_name' in board.scan) && !('org_url' in board.scan));
  });

  test('two report calls for one board merge; an org-only report leaves scan null', async (t) => {
    const rows = (slug, ats) => [normalize({ companySlug: slug, company: slug, title: 'PM', location: 'Remote', description: 'Build.', url: `https://x/${slug}` }, ats)];
    t.mock.method(ADAPTERS.smartrecruiters, 'fetch', async (slug, ctx) => {
      ctx.report({ ats: 'smartrecruiters', listed: 3, prefiltered: 1, hydrated: 1, capped: false });
      ctx.report({ ats: 'smartrecruiters', org_name: 'AcmePay Ltd', org_url: 'careers.acmepay.example' });
      return rows(slug, 'smartrecruiters');
    });
    const merged = await fetchJobsDetailed({ company: 'acmepay' });
    assert.deepEqual(merged.boards[0].scan, { listed: 3, prefiltered: 1, hydrated: 1, capped: false });
    assert.equal(merged.boards[0].jobs_found, 3);
    assert.deepEqual(orgOf(merged.boards[0]), ['smartrecruiters', 'AcmePay Ltd', 'careers.acmepay.example']);

    t.mock.method(ADAPTERS.greenhouse, 'fetch', async (slug, ctx) => {
      ctx.report({ ats: 'greenhouse', org_name: 'Fixture Board', org_url: null });
      return rows(slug, 'greenhouse');
    });
    const orgOnly = await fetchJobsDetailed({ company: 'fixture-gh' });
    assert.equal(orgOnly.boards[0].scan, null);
    assert.equal(orgOnly.boards[0].jobs_found, 1);
    assert.deepEqual(orgOf(orgOnly.boards[0]), ['greenhouse', 'Fixture Board', null]);
  });
});

describe('fetchJobsDetailed — ArgumentError before any request', () => {
  const isArgumentError = (pattern) => (err) => {
    assert.ok(err instanceof ArgumentError, `expected ArgumentError, got ${err?.name}: ${err?.message}`);
    assert.equal(err.code, 'invalid_args');
    assert.match(err.message, pattern);
    return true;
  };

  test('a missing company', async (t) => {
    const calls = mockFetchByHost(t, {});
    await assert.rejects(fetchJobsDetailed({}), isArgumentError(/company/));
    await assert.rejects(fetchJobs(), isArgumentError(/company/));
    assert.equal(calls.length, 0);
  });

  test('an unknown ats', async (t) => {
    const calls = mockFetchByHost(t, {});
    await assert.rejects(fetchJobsDetailed({ company: 'fixture-gh', ats: 'taleo' }), isArgumentError(/Unknown ATS: taleo/));
    assert.equal(calls.length, 0);
  });

  test('a titleFilter or filter that does not compile, named in the message', async (t) => {
    const calls = mockFetchByHost(t, {});
    await assert.rejects(fetchJobsDetailed({ company: 'fixture-gh', titleFilter: '(' }), isArgumentError(/^titleFilter:/));
    await assert.rejects(fetchJobsDetailed({ company: 'fixture-gh', filter: '[' }), isArgumentError(/^filter:/));
    assert.equal(calls.length, 0, 'a bad pattern costs no upstream request');
  });
});
