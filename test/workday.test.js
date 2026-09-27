import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWorkday, hasWorkday } from '../src/adapters/workday.js';
import { applyFilters } from '../src/filters.js';

/**
 * Workday is registry-only, two-call (list POST + per-job detail GET).
 * Mock routes by URL: ends with '/jobs' -> list; else -> detail.
 * t.mock.method auto-restores per test; no afterEach needed.
 *
 * MULTI_LIST_FIXTURE and MULTI_DETAIL_FIXTURE follow a live tenant's shape
 * (2026-09-27): a posting open in several places has `locationsText` like
 * "14 Locations" on the list, and its detail carries `location`,
 * `additionalLocations[]` and `remoteType`.
 */

const CTX = {
  config: { tenant: 'cisco', env: 'wd5', site: 'Cisco_Careers' },
  companyName: 'Cisco',
};

const LIST_FIXTURE = {
  total: 2,
  jobPostings: [
    { title: 'Staff Product Manager', externalPath: '/job/USA/Staff-PM_R123', locationsText: 'San Jose, CA', postedOn: 'Posted 5 Days Ago' },
    { title: 'Data Analyst', externalPath: '/job/Remote/Data-Analyst_R124', locationsText: 'Remote - USA', postedOn: 'Posted 40+ Days Ago' },
  ],
};

const DETAIL_FIXTURE = {
  jobPostingInfo: {
    jobDescription: '<p>Build things. Salary: $150,000 - $200,000.</p>',
    startDate: '2026-05-01',
    location: 'San Jose, CA, United States',
  },
};

const MULTI_LIST_FIXTURE = {
  total: 3,
  jobPostings: [
    { title: 'Staff Product Manager', externalPath: '/job/USA/Staff-PM_R123', locationsText: 'San Jose, California, US', postedOn: 'Posted 5 Days Ago', bulletFields: ['R123'] },
    { title: 'Software Technical Leader', externalPath: '/job/Vancouver/Software-Technical-Leader_2019470', locationsText: '14 Locations', postedOn: 'Posted 8 Days Ago', bulletFields: ['2019470'] },
    { title: 'Account Manager', externalPath: '/job/Galway/Account-Manager_R125', locationsText: 'Galway, Ireland', postedOn: 'Posted Today', bulletFields: ['R125'] },
  ],
};

const MULTI_DETAIL_FIXTURE = {
  jobPostingInfo: {
    id: '5c3a9b4d3f2e01a1b2c3d4e5f6a7b8c9',
    title: 'Software Technical Leader',
    jobDescription: '<p>Lead the platform team.</p>',
    location: 'Vancouver, British Columbia, Canada',
    additionalLocations: ['Toronto, Ontario, Canada', 'Austin, Texas, United States of America'],
    postedOn: 'Posted 8 Days Ago',
    startDate: '2026-09-19',
    timeType: 'Full time',
    jobReqId: '2019470',
    remoteType: 'Remote',
    country: { descriptor: 'Canada', id: 'a30a87ed25634629aa6c3958aa2b91ea' },
  },
};

const GALWAY_DETAIL_FIXTURE = {
  jobPostingInfo: {
    title: 'Account Manager',
    jobDescription: '<p>Grow the EMEA accounts.</p>',
    location: 'Galway, Ireland',
    additionalLocations: [],
    startDate: '2026-09-26',
    timeType: 'Full time',
    jobReqId: 'R125',
    remoteType: 'Office - Flexible',
  },
};

const MULTI_DETAILS = {
  '/job/Vancouver/Software-Technical-Leader_2019470': MULTI_DETAIL_FIXTURE,
  '/job/Galway/Account-Manager_R125': GALWAY_DETAIL_FIXTURE,
};

// Routes detail requests by externalPath; anything not in `details` gets DETAIL_FIXTURE.
function routedMock(t, { list = MULTI_LIST_FIXTURE, details = MULTI_DETAILS } = {}) {
  const calls = { list: 0, detail: 0, urls: [] };
  t.mock.method(global, 'fetch', async (url) => {
    calls.urls.push(url);
    if (url.endsWith('/jobs')) {
      calls.list += 1;
      return { ok: true, status: 200, json: async () => list };
    }
    calls.detail += 1;
    const path = Object.keys(details).find(p => url.endsWith(p));
    return { ok: true, status: 200, json: async () => (path ? details[path] : DETAIL_FIXTURE) };
  });
  return calls;
}

function listMock(t, { status = 200, list = LIST_FIXTURE, detail = DETAIL_FIXTURE } = {}) {
  const calls = { list: 0, detail: 0, urls: [] };
  t.mock.method(global, 'fetch', async (url) => {
    calls.urls.push(url);
    if (url.endsWith('/jobs')) {
      calls.list += 1;
      return { ok: status >= 200 && status < 300, status, json: async () => list };
    }
    calls.detail += 1;
    return { ok: true, status: 200, json: async () => detail };
  });
  return calls;
}

// Build a paginated list mock: total N, 20 per page, offset read from POST body.
// Live tenants come in two shapes: `total` repeated on every page (default), or
// the real `total` at offset 0 and `total: 0` on every later page
// (totalOnFirstPageOnly). `reportedTotal` forces one `total` on every page.
// `titles` overrides the title at a given row index. `failAt: { offset, status }`
// makes the list request at that offset fail.
function paginatedMock(t, total, { totalOnFirstPageOnly = false, reportedTotal, titles = {}, failAt = null } = {}) {
  const calls = { list: 0, detail: 0 };
  t.mock.method(global, 'fetch', async (url, opts) => {
    if (url.endsWith('/jobs')) {
      calls.list += 1;
      const { offset } = JSON.parse(opts.body);
      if (failAt && failAt.offset === offset) {
        return { ok: false, status: failAt.status, json: async () => ({}) };
      }
      const page = [];
      for (let i = offset; i < Math.min(offset + 20, total); i++) {
        page.push({ title: titles[i] || `Job ${i}`, externalPath: `/job/x/R${i}`, locationsText: 'Remote', postedOn: 'Posted Today' });
      }
      let reported = total;
      if (reportedTotal !== undefined) reported = reportedTotal;
      else if (totalOnFirstPageOnly && offset > 0) reported = 0;
      return { ok: true, status: 200, json: async () => ({ total: reported, jobPostings: page }) };
    }
    calls.detail += 1;
    return { ok: true, status: 200, json: async () => DETAIL_FIXTURE };
  });
  return calls;
}

const LIST_SHAPES = [
  ['total on every page', { totalOnFirstPageOnly: false }],
  ['total on page 1 only', { totalOnFirstPageOnly: true }],
];

describe('fetchWorkday', () => {
  test('registry-only: returns [] with no config and does not fetch', async (t) => {
    const calls = listMock(t);
    const jobs = await fetchWorkday('cisco', {});
    assert.deepEqual(jobs, []);
    assert.equal(calls.list + calls.detail, 0);
  });

  test('returns [] with partial config (missing site)', async (t) => {
    const calls = listMock(t);
    const jobs = await fetchWorkday('cisco', { config: { tenant: 'cisco', env: 'wd5' } });
    assert.deepEqual(jobs, []);
    assert.equal(calls.list + calls.detail, 0);
  });

  test('list call uses correct URL, method, header, body', async (t) => {
    let captured;
    t.mock.method(global, 'fetch', async (url, opts) => {
      if (url.endsWith('/jobs')) {
        captured = { url, opts };
        return { ok: true, status: 200, json: async () => ({ total: 0, jobPostings: [] }) };
      }
      return { ok: true, status: 200, json: async () => DETAIL_FIXTURE };
    });
    await fetchWorkday('cisco', { ...CTX });
    assert.equal(captured.url, 'https://cisco.wd5.myworkdayjobs.com/wday/cxs/cisco/Cisco_Careers/jobs');
    assert.equal(captured.opts.method, 'POST');
    assert.equal(captured.opts.headers['Content-Type'], 'application/json');
    assert.deepEqual(JSON.parse(captured.opts.body), { appliedFacets: {}, limit: 20, offset: 0, searchText: '' });
  });

  test('detail URL concatenates externalPath onto CXS base (single /job/, no //)', async (t) => {
    const calls = listMock(t);
    await fetchWorkday('cisco', { ...CTX });
    const detailUrl = calls.urls.find(u => u.includes('/job/'));
    // externalPath already carries the '/job/...' segment, so it is
    // appended directly to the CXS base. Inserting another '/job' would
    // produce '/job/job/...' which Workday rejects with 422.
    assert.equal(detailUrl, 'https://cisco.wd5.myworkdayjobs.com/wday/cxs/cisco/Cisco_Careers/job/USA/Staff-PM_R123');
    assert.doesNotMatch(detailUrl.replace('https://', ''), /\/\//);
  });

  test('maps a job to the unified schema', async (t) => {
    listMock(t);
    const jobs = await fetchWorkday('cisco', { ...CTX });
    const pm = jobs.find(j => j.title === 'Staff Product Manager');
    assert.ok(pm);
    assert.equal(pm.company, 'Cisco');
    assert.equal(pm.companySlug, 'cisco');
    assert.equal(pm.ats, 'workday');
    assert.equal(pm.location, 'San Jose, CA, United States');
    assert.equal(pm.url, 'https://cisco.wd5.myworkdayjobs.com/Cisco_Careers/job/USA/Staff-PM_R123');
    assert.equal(pm.metadata.workdayTenant, 'cisco');
    assert.equal(pm.metadata.workdaySite, 'Cisco_Careers');
    assert.equal(pm.metadata.externalPath, '/job/USA/Staff-PM_R123');
    assert.equal(pm.postedAt, '2026-05-01T00:00:00.000Z');
  });

  test('job ids are unchanged (location still feeds the id, locations does not)', async (t) => {
    listMock(t);
    const jobs = await fetchWorkday('cisco', { ...CTX });
    assert.deepEqual(jobs.map(j => j.id), ['498edcfadb95', 'f4d666429148']);
  });

  test('extracts salary from detail description text', async (t) => {
    listMock(t);
    const jobs = await fetchWorkday('cisco', { ...CTX });
    const pm = jobs.find(j => j.title === 'Staff Product Manager');
    assert.deepEqual(pm.salary, { min: 150000, max: 200000, currency: 'USD', period: 'year', source: 'text' });
  });

  test('decodes the decimal entities Workday uses for + \' = and @ (issue #66)', async (t) => {
    const detail = {
      jobPostingInfo: {
        ...DETAIL_FIXTURE.jobPostingInfo,
        jobDescription: '<p>Skills: C&#43;&#43;, and Python. 8&#43; years. Bachelor&#39;s degree.</p><p>TTC &#61; base &#43; commission. Contact hiring&#64;example.com.</p>',
      },
    };
    listMock(t, { detail });
    const jobs = await fetchWorkday('cisco', { ...CTX });
    const pm = jobs.find(j => j.title === 'Staff Product Manager');
    assert.match(pm.description, /C\+\+, and Python/);
    assert.match(pm.description, /8\+ years/);
    assert.match(pm.description, /Bachelor's degree/);
    assert.match(pm.description, /TTC = base \+ commission/);
    assert.match(pm.description, /hiring@example\.com/);
  });

  for (const [shape, shapeOpts] of LIST_SHAPES) {
    describe(`list paging, ${shape}`, () => {
      test('paginates the list (25 jobs -> 2 POSTs)', async (t) => {
        const calls = paginatedMock(t, 25, shapeOpts);
        const jobs = await fetchWorkday('cisco', { ...CTX });
        assert.equal(calls.list, 2);
        assert.equal(jobs.length, 25);
      });

      test('scans past row 40 (127 jobs -> 7 POSTs, title match at row 100)', async (t) => {
        const calls = paginatedMock(t, 127, { ...shapeOpts, titles: { 100: 'Senior Product Manager' } });
        const jobs = await fetchWorkday('cisco', {
          ...CTX,
          filterContext: { titleFilter: 'product manager', limit: 100 },
        });
        assert.equal(calls.list, 7);
        assert.equal(calls.detail, 1);
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0].title, 'Senior Product Manager');
      });

      test('hard cap = 100 list pages (5000 jobs -> 100 POSTs)', async (t) => {
        const calls = paginatedMock(t, 5000, shapeOpts);
        const jobs = await fetchWorkday('cisco', {
          ...CTX,
          filterContext: { titleFilter: 'no such role', limit: 100 },
        });
        assert.equal(calls.list, 100);
        assert.deepEqual(jobs, []);
      });

      test('hard cap = 100 detail fetches under a description filter', async (t) => {
        const calls = paginatedMock(t, 300, shapeOpts);
        await fetchWorkday('cisco', { ...CTX, filterContext: { filter: 'engineer', limit: 100 } });
        assert.equal(calls.list, 15);
        assert.equal(calls.detail, 100);
      });

      test('limit truncates detail fetches when no description filter', async (t) => {
        const calls = paginatedMock(t, 50, shapeOpts);
        await fetchWorkday('cisco', { ...CTX, filterContext: { limit: 10 } });
        assert.equal(calls.detail, 10);
      });

      test('offset extends the detail budget to offset + limit', async (t) => {
        const calls = paginatedMock(t, 50, shapeOpts);
        await fetchWorkday('cisco', { ...CTX, filterContext: { limit: 10, offset: 10 } });
        assert.equal(calls.detail, 20);
      });

      test('offset + limit is still capped at 100 detail fetches', async (t) => {
        const calls = paginatedMock(t, 300, shapeOpts);
        await fetchWorkday('cisco', { ...CTX, filterContext: { limit: 50, offset: 80 } });
        assert.equal(calls.detail, 100);
      });
    });
  }

  test('total: 0 on every page with a full first page keeps paging to a short page', async (t) => {
    const calls = paginatedMock(t, 25, { reportedTotal: 0 });
    const jobs = await fetchWorkday('cisco', { ...CTX });
    assert.equal(calls.list, 2);
    assert.equal(jobs.length, 25);
  });

  test('500 at offset 40 keeps the 40 postings already read', async (t) => {
    const calls = paginatedMock(t, 127, { totalOnFirstPageOnly: true, failAt: { offset: 40, status: 500 } });
    const jobs = await fetchWorkday('cisco', { ...CTX });
    assert.equal(calls.list, 3);
    assert.equal(jobs.length, 40);
    assert.equal(jobs[39].title, 'Job 39');
  });

  test('404 at offset 40 keeps the 40 postings already read', async (t) => {
    const calls = paginatedMock(t, 127, { failAt: { offset: 40, status: 404 } });
    const jobs = await fetchWorkday('cisco', { ...CTX });
    assert.equal(calls.list, 3);
    assert.equal(jobs.length, 40);
  });

  test('filter-aware: titleFilter avoids N+1 (1 detail fetch, not 2)', async (t) => {
    const calls = listMock(t);
    const jobs = await fetchWorkday('cisco', {
      ...CTX,
      filterContext: { titleFilter: 'product manager', limit: 100 },
    });
    assert.equal(calls.detail, 1); // only the PM posting hydrated
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].title, 'Staff Product Manager');
  });

  test('locationExcludes pre-filters before detail fetch', async (t) => {
    const calls = listMock(t);
    const jobs = await fetchWorkday('cisco', {
      ...CTX,
      filterContext: { locationExcludes: ['Remote'], limit: 100 },
    });
    assert.equal(calls.detail, 1);
    assert.equal(jobs[0].title, 'Staff Product Manager');
  });

  test('postedWithinDays pre-filters via relative postedOn', async (t) => {
    const calls = listMock(t);
    const jobs = await fetchWorkday('cisco', {
      ...CTX,
      filterContext: { postedWithinDays: 7, limit: 100 },
    });
    // "5 Days Ago" kept, "40+ Days Ago" dropped
    assert.equal(calls.detail, 1);
    assert.equal(jobs[0].title, 'Staff Product Manager');
  });

  test('returns [] on list 404 at offset 0', async (t) => {
    listMock(t, { status: 404, list: {} });
    const jobs = await fetchWorkday('cisco', { ...CTX });
    assert.deepEqual(jobs, []);
  });

  test('throws on list 500 at offset 0, with the triple in the message', async (t) => {
    listMock(t, { status: 500, list: {} });
    await assert.rejects(
      () => fetchWorkday('cisco', { ...CTX }),
      /Workday API error for cisco \(cisco\/wd5\/Cisco_Careers\): 500/
    );
  });

  test('detail failure keeps the job with empty description', async (t) => {
    t.mock.method(global, 'fetch', async (url) => {
      if (url.endsWith('/jobs')) return { ok: true, status: 200, json: async () => LIST_FIXTURE };
      return { ok: false, status: 503, json: async () => ({}) };
    });
    const jobs = await fetchWorkday('cisco', { ...CTX });
    assert.equal(jobs.length, 2);
    assert.equal(jobs[0].description, '');
    assert.equal(jobs[0].title, 'Staff Product Manager');
  });
});

describe('fetchWorkday workplace and locations (issue #68)', () => {
  const withRemoteType = (remoteType) => ({ jobPostingInfo: { ...DETAIL_FIXTURE.jobPostingInfo, remoteType } });

  test('remoteType maps to workplace with source ats; Office - Flexible is hybrid', async (t) => {
    const cases = [
      ['Remote', 'remote'],
      ['Hybrid', 'hybrid'],
      ['Office - Flexible', 'hybrid'],
      ['Office', 'onsite'],
      ['On-site', 'onsite'],
      ['Onsite', 'onsite'],
    ];
    for (const [remoteType, type] of cases) {
      listMock(t, { detail: withRemoteType(remoteType) });
      const [job] = await fetchWorkday('cisco', { ...CTX, filterContext: { titleFilter: 'product manager', limit: 100 } });
      assert.deepEqual(job.workplace, { type, source: 'ats' }, remoteType);
      assert.equal(job.locationType, type, remoteType);
    }
  });

  test('no remoteType or an unrecognized one leaves the text fallback in charge', async (t) => {
    listMock(t);
    const jobs = await fetchWorkday('cisco', { ...CTX });
    const pm = jobs.find(j => j.title === 'Staff Product Manager');
    assert.deepEqual(pm.workplace, { type: 'unknown', source: null });
    assert.equal(pm.locationType, 'unknown');

    listMock(t, { detail: withRemoteType('Field') });
    const [field] = await fetchWorkday('cisco', { ...CTX, filterContext: { titleFilter: 'product manager', limit: 100 } });
    assert.deepEqual(field.workplace, { type: 'unknown', source: null });
  });

  test('locations carries the detail location, then every additionalLocations entry', async (t) => {
    routedMock(t);
    const jobs = await fetchWorkday('cisco', { ...CTX });
    const lead = jobs.find(j => j.title === 'Software Technical Leader');
    assert.equal(lead.location, 'Vancouver, British Columbia, Canada');
    assert.deepEqual(lead.locations, [
      'Vancouver, British Columbia, Canada',
      'Toronto, Ontario, Canada',
      'Austin, Texas, United States of America',
    ]);
    assert.deepEqual(lead.workplace, { type: 'remote', source: 'ats' });
    const pm = jobs.find(j => j.title === 'Staff Product Manager');
    assert.deepEqual(pm.locations, ['San Jose, CA, United States']);
  });

  test('an "N Locations" list row survives the location_includes pre-filter and is hydrated', async (t) => {
    const calls = routedMock(t);
    const jobs = await fetchWorkday('cisco', {
      ...CTX,
      filterContext: { locationIncludes: ['United States'], limit: 100 },
    });
    // "San Jose, California, US" and "Galway, Ireland" fail the list-text
    // check; "14 Locations" is kept and fetched so the detail can decide.
    assert.equal(calls.detail, 1);
    assert.match(calls.urls.find(u => u.includes('/job/')), /Software-Technical-Leader_2019470$/);
    assert.deepEqual(jobs.map(j => j.title), ['Software Technical Leader']);
    assert.equal(applyFilters(jobs, { locationIncludes: ['United States'] }).length, 1, 'kept by the post-detail pass on a secondary location');
    assert.equal(applyFilters(jobs, { locationIncludes: ['Germany'] }).length, 0, 'the post-detail pass still drops it when no location matches');
  });

  test('a plain list row is still dropped by the pre-filter, so the exception stays narrow', async (t) => {
    const calls = routedMock(t);
    const jobs = await fetchWorkday('cisco', {
      ...CTX,
      filterContext: { locationIncludes: ['Ireland'], limit: 100 },
    });
    assert.equal(calls.detail, 2, 'Galway and the "14 Locations" row, not San Jose');
    assert.deepEqual(jobs.map(j => j.title).sort(), ['Account Manager', 'Software Technical Leader']);
    assert.deepEqual(applyFilters(jobs, { locationIncludes: ['Ireland'] }).map(j => j.title), ['Account Manager']);
  });

  test('location_excludes drops the multi-location job only when every location matches', async (t) => {
    routedMock(t);
    const jobs = await fetchWorkday('cisco', { ...CTX });
    const titles = (opts) => applyFilters(jobs, opts).map(j => j.title).sort();
    assert.deepEqual(titles({ locationExcludes: ['Canada'] }), ['Account Manager', 'Software Technical Leader', 'Staff Product Manager'], 'still open in Austin');
    assert.deepEqual(titles({ locationExcludes: ['Canada', 'United States'] }), ['Account Manager']);
  });
});

describe('hasWorkday', () => {
  test('always false (registry-only invariant)', async () => {
    assert.equal(await hasWorkday('cisco'), false);
    assert.equal(await hasWorkday('anything'), false);
  });
});
