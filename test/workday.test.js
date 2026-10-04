import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWorkday, hasWorkday } from '../src/adapters/workday.js';
import { applyFilters } from '../src/filters.js';
import { disableRetries, isAtsError, networkError } from './helpers.js';

disableRetries();

/**
 * Workday is registry-only, two-call (list POST + per-job detail GET).
 * Mock routes by URL: ends with '/jobs' -> list; else -> detail.
 * t.mock.method auto-restores per test; no afterEach needed.
 *
 * MULTI_LIST_FIXTURE and MULTI_DETAIL_FIXTURE follow a live tenant's shape
 * (2026-09-27): a posting open in several places has `locationsText` like
 * "14 Locations" on the list, and its detail carries `location`,
 * `additionalLocations[]` and `remoteType`.
 *
 * The detail's top level is { jobPostingInfo, hiringOrganization,
 * similarJobs, userAuthenticated }. `hiringOrganization` is { name, url }
 * with a legal-entity name and, on the tenant checked, an empty url; the
 * list carries neither. DETAIL_FIXTURE keeps that pair as returned.
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
  hiringOrganization: { name: '020 Cisco Systems, Inc.', url: '' },
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

  test('500 at offset 40 (thrown once the retries are used up) keeps the 40 postings already read', async (t) => {
    const calls = paginatedMock(t, 127, { totalOnFirstPageOnly: true, failAt: { offset: 40, status: 500 } });
    const jobs = await fetchWorkday('cisco', { ...CTX });
    assert.equal(calls.list, 3);
    assert.equal(jobs.length, 40);
    assert.equal(jobs[39].title, 'Job 39');
  });

  test('a network error at offset 40 keeps the 40 postings already read', async (t) => {
    let listCalls = 0;
    t.mock.method(global, 'fetch', async (url, opts) => {
      if (!url.endsWith('/jobs')) return { ok: true, status: 200, json: async () => DETAIL_FIXTURE };
      listCalls += 1;
      const { offset } = JSON.parse(opts.body);
      if (offset === 40) throw networkError();
      const page = Array.from({ length: 20 }, (_, i) => ({ title: `Job ${offset + i}`, externalPath: `/job/x/R${offset + i}`, locationsText: 'Remote', postedOn: 'Posted Today' }));
      return { ok: true, status: 200, json: async () => ({ total: 127, jobPostings: page }) };
    });
    const jobs = await fetchWorkday('cisco', { ...CTX });
    assert.equal(listCalls, 3);
    assert.equal(jobs.length, 40);
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

  test('throws on list 422 at offset 0 (a wrong site), with the triple in the message', async (t) => {
    listMock(t, { status: 422, list: {} });
    await assert.rejects(
      () => fetchWorkday('cisco', { ...CTX }),
      /Workday API error for cisco \(cisco\/wd5\/Cisco_Careers\): 422/
    );
  });

  test('throws ats_unreachable carrying the status on list 500 at offset 0', async (t) => {
    listMock(t, { status: 500, list: {} });
    await assert.rejects(() => fetchWorkday('cisco', { ...CTX }), isAtsError('ats_unreachable', 500));
  });

  test('throws rate_limited on list 429 at offset 0', async (t) => {
    listMock(t, { status: 429, list: {} });
    await assert.rejects(() => fetchWorkday('cisco', { ...CTX }), isAtsError('rate_limited', 429));
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

// List rows whose text carries a short code only as a substring: "us" inside
// Australia and Brussels, "uk" inside Ukraine. Same shape as a live tenant's
// rows (2026-09-27: "North Sydney, Australia", "Diegem, Belgium", "2 Locations").
const COLLISION_LIST_FIXTURE = {
  total: 6,
  jobPostings: [
    { title: 'Account Executive', externalPath: '/job/Sydney-Australia/Account-Executive_2025384', locationsText: 'Sydney, Australia', postedOn: 'Posted Today', bulletFields: ['2025384'] },
    { title: 'Solutions Engineer', externalPath: '/job/Brussels-Belgium/Solutions-Engineer_2020019', locationsText: 'Brussels, Belgium', postedOn: 'Posted Today', bulletFields: ['2020019'] },
    { title: 'Software Engineer', externalPath: '/job/Kyiv-Ukraine/Software-Engineer_2024454', locationsText: 'Kyiv, Ukraine', postedOn: 'Posted 4 Days Ago', bulletFields: ['2024454'] },
    { title: 'Product Manager', externalPath: '/job/San-Francisco-California-US/Product-Manager_2023289', locationsText: 'San Francisco, California, US', postedOn: 'Posted 6 Days Ago', bulletFields: ['2023289'] },
    { title: 'Account Manager', externalPath: '/job/London-UK/Account-Manager_2023243', locationsText: 'London, UK', postedOn: 'Posted 6 Days Ago', bulletFields: ['2023243'] },
    { title: 'Renewals Manager', externalPath: '/job/Amsterdam-Netherlands/Renewals-Manager_2024946', locationsText: '2 Locations', postedOn: 'Posted 3 Days Ago', bulletFields: ['2024946'] },
  ],
};

const detailAt = (location, additionalLocations = []) => ({
  jobPostingInfo: { jobDescription: '<p>Build.</p>', startDate: '2026-09-20', location, additionalLocations },
});

const COLLISION_DETAILS = {
  '/job/Sydney-Australia/Account-Executive_2025384': detailAt('Sydney, Australia'),
  '/job/Brussels-Belgium/Solutions-Engineer_2020019': detailAt('Brussels, Belgium'),
  '/job/Kyiv-Ukraine/Software-Engineer_2024454': detailAt('Kyiv, Ukraine'),
  '/job/San-Francisco-California-US/Product-Manager_2023289': detailAt('San Francisco, California, US'),
  '/job/London-UK/Account-Manager_2023243': detailAt('London, UK'),
  '/job/Amsterdam-Netherlands/Renewals-Manager_2024946': detailAt('Amsterdam, Netherlands', ['Austin, Texas, US']),
};

describe('fetchWorkday location pre-filter shares the applyFilters matcher (issue #61)', () => {
  const collisionMock = (t) => routedMock(t, { list: COLLISION_LIST_FIXTURE, details: COLLISION_DETAILS });
  const titles = (jobs) => jobs.map(j => j.title).sort();
  const hydrated = (calls) => calls.urls.filter(u => u.includes('/job/')).map(u => u.slice(u.indexOf('/job/'))).sort();

  test('locationExcludes ["US"] keeps Sydney, Australia and Brussels, Belgium', async (t) => {
    const calls = collisionMock(t);
    const jobs = await fetchWorkday('cisco', { ...CTX, filterContext: { locationExcludes: ['US'], limit: 100 } });
    assert.equal(calls.detail, 5, 'every row but San Francisco is hydrated');
    assert.deepEqual(titles(jobs), ['Account Executive', 'Account Manager', 'Renewals Manager', 'Software Engineer', 'Solutions Engineer']);
    assert.deepEqual(titles(applyFilters(jobs, { locationExcludes: ['US'] })), titles(jobs), 'the post-detail pass keeps the same set');
  });

  test('locationIncludes ["US"] fetches no detail for a row that matches only as a substring', async (t) => {
    const calls = collisionMock(t);
    const jobs = await fetchWorkday('cisco', { ...CTX, filterContext: { locationIncludes: ['US'], limit: 100 } });
    assert.equal(calls.detail, 2);
    assert.deepEqual(hydrated(calls), [
      '/job/Amsterdam-Netherlands/Renewals-Manager_2024946',
      '/job/San-Francisco-California-US/Product-Manager_2023289',
    ]);
    assert.deepEqual(titles(jobs), ['Product Manager', 'Renewals Manager']);
  });

  test('locationIncludes ["UK"] fetches London, not Kyiv, Ukraine', async (t) => {
    const calls = collisionMock(t);
    await fetchWorkday('cisco', { ...CTX, filterContext: { locationIncludes: ['UK'], limit: 100 } });
    assert.deepEqual(hydrated(calls), [
      '/job/Amsterdam-Netherlands/Renewals-Manager_2024946',
      '/job/London-UK/Account-Manager_2023243',
    ]);
  });

  test('empty and whitespace-only exclude keywords change nothing', async (t) => {
    for (const locationExcludes of [[''], [' ']]) {
      const calls = collisionMock(t);
      const jobs = await fetchWorkday('cisco', { ...CTX, filterContext: { locationExcludes, limit: 100 } });
      assert.equal(calls.detail, 6, JSON.stringify(locationExcludes));
      assert.equal(jobs.length, 6, JSON.stringify(locationExcludes));
    }
  });

  test('keywords are trimmed before the word-boundary check', async (t) => {
    const calls = collisionMock(t);
    await fetchWorkday('cisco', { ...CTX, filterContext: { locationIncludes: [' us '], limit: 100 } });
    assert.equal(calls.detail, 2, 'the same two rows as ["US"]');
  });

  test('an "N Locations" row survives both pre-filters and the post-detail pass decides', async (t) => {
    const inc = collisionMock(t);
    const included = await fetchWorkday('cisco', { ...CTX, filterContext: { locationIncludes: ['Ukraine'], limit: 100 } });
    assert.deepEqual(hydrated(inc), [
      '/job/Amsterdam-Netherlands/Renewals-Manager_2024946',
      '/job/Kyiv-Ukraine/Software-Engineer_2024454',
    ]);
    assert.deepEqual(applyFilters(included, { locationIncludes: ['Ukraine'] }).map(j => j.title), ['Software Engineer']);

    // Even a keyword that matches the placeholder text itself does not drop the row.
    const exc = collisionMock(t);
    const excluded = await fetchWorkday('cisco', { ...CTX, filterContext: { locationExcludes: ['Locations', 'Netherlands'], limit: 100 } });
    assert.ok(hydrated(exc).includes('/job/Amsterdam-Netherlands/Renewals-Manager_2024946'));
    const renewals = excluded.find(j => j.title === 'Renewals Manager');
    assert.deepEqual(renewals.locations, ['Amsterdam, Netherlands', 'Austin, Texas, US']);
    assert.ok(applyFilters(excluded, { locationExcludes: ['Netherlands'] }).some(j => j.title === 'Renewals Manager'), 'still open in Austin');
    assert.ok(!applyFilters(excluded, { locationExcludes: ['Netherlands', 'US'] }).some(j => j.title === 'Renewals Manager'), 'dropped once every location matches');
  });
});

describe('fetchWorkday scan report (issue #90)', () => {
  const spy = () => {
    const reports = [];
    return { reports, report: (scan) => reports.push(scan) };
  };

  // The scan counts plus what the hydrated detail said about the org.
  const ORG = { org_name: '020 Cisco Systems, Inc.', org_url: null };

  test('reports the scan once: listed, prefiltered, hydrated, capped, plus the org from the detail', async (t) => {
    listMock(t);
    const { reports, report } = spy();
    await fetchWorkday('cisco', { ...CTX, report, filterContext: { titleFilter: 'product manager', limit: 100 } });
    assert.deepEqual(reports, [{ listed: 2, prefiltered: 1, hydrated: 1, capped: false, ...ORG }]);
  });

  test('an unfiltered scan that fits the budget is not capped', async (t) => {
    paginatedMock(t, 25);
    const { reports, report } = spy();
    await fetchWorkday('cisco', { ...CTX, report });
    assert.deepEqual(reports, [{ listed: 25, prefiltered: 25, hydrated: 25, capped: false, ...ORG }]);
  });

  test('capped when MAX_DETAIL_FETCHES cut the candidates', async (t) => {
    paginatedMock(t, 300);
    const { reports, report } = spy();
    await fetchWorkday('cisco', { ...CTX, report, filterContext: { filter: 'engineer', limit: 100 } });
    assert.deepEqual(reports, [{ listed: 300, prefiltered: 300, hydrated: 100, capped: true, ...ORG }]);
  });

  test('capped when the list hard cap stopped the scan, even with nothing to hydrate; no detail means no org', async (t) => {
    paginatedMock(t, 5000);
    const { reports, report } = spy();
    await fetchWorkday('cisco', { ...CTX, report, filterContext: { titleFilter: 'no such role', limit: 100 } });
    assert.deepEqual(reports, [{ listed: 2000, prefiltered: 0, hydrated: 0, capped: true, org_name: null, org_url: null }]);
  });

  test('no report on the registry-only bail or a 404', async (t) => {
    const { reports, report } = spy();
    listMock(t);
    await fetchWorkday('cisco', { report });
    listMock(t, { status: 404, list: {} });
    await fetchWorkday('cisco', { ...CTX, report });
    assert.deepEqual(reports, []);
  });
});

describe('fetchWorkday org identity (issue #58)', () => {
  const spy = () => {
    const reports = [];
    return { reports, report: (r) => reports.push(r) };
  };
  const withOrg = (hiringOrganization) => ({ ...DETAIL_FIXTURE, hiringOrganization });
  const orgOf = (reports) => ({ org_name: reports[0].org_name, org_url: reports[0].org_url });

  test('org_name is hiringOrganization.name as the tenant states it; an empty url is null', async (t) => {
    listMock(t);
    const { reports, report } = spy();
    await fetchWorkday('cisco', { ...CTX, report });
    assert.deepEqual(orgOf(reports), { org_name: '020 Cisco Systems, Inc.', org_url: null });
  });

  test('a company url becomes its bare host', async (t) => {
    listMock(t, { detail: withOrg({ name: 'Cisco Systems, Inc.', url: 'https://www.cisco.com/c/en/us/about/careers.html' }) });
    const { reports, report } = spy();
    await fetchWorkday('cisco', { ...CTX, report });
    assert.deepEqual(orgOf(reports), { org_name: 'Cisco Systems, Inc.', org_url: 'www.cisco.com' });
  });

  test('a url on myworkdayjobs.com is the ATS host and yields null', async (t) => {
    listMock(t, { detail: withOrg({ name: 'Cisco Systems, Inc.', url: 'https://cisco.wd5.myworkdayjobs.com/Cisco_Careers' }) });
    const { reports, report } = spy();
    await fetchWorkday('cisco', { ...CTX, report });
    assert.deepEqual(orgOf(reports), { org_name: 'Cisco Systems, Inc.', org_url: null });
  });

  test('a detail without hiringOrganization reports null, never companyName or the slug', async (t) => {
    listMock(t, { detail: { jobPostingInfo: DETAIL_FIXTURE.jobPostingInfo } });
    const { reports, report } = spy();
    await fetchWorkday('cisco', { ...CTX, report });
    assert.deepEqual(orgOf(reports), { org_name: null, org_url: null });
  });

  test('the first hydrated posting in list order decides, whichever detail answers first', async (t) => {
    // Two postings under two legal entities. The second detail resolves
    // first; the report still carries the first row's entity.
    const gate = {};
    gate.first = new Promise(resolve => { gate.release = resolve; });
    t.mock.method(global, 'fetch', async (url) => {
      if (url.endsWith('/jobs')) return { ok: true, status: 200, json: async () => LIST_FIXTURE };
      if (url.endsWith('/job/USA/Staff-PM_R123')) {
        await gate.first;
        return { ok: true, status: 200, json: async () => withOrg({ name: 'Entity One, Inc.', url: '' }) };
      }
      gate.release();
      return { ok: true, status: 200, json: async () => withOrg({ name: 'Entity Two GmbH', url: '' }) };
    });
    const { reports, report } = spy();
    await fetchWorkday('cisco', { ...CTX, report });
    assert.equal(reports[0].org_name, 'Entity One, Inc.');
  });
});

describe('hasWorkday', () => {
  test('always false (registry-only invariant)', async () => {
    assert.equal(await hasWorkday('cisco'), false);
    assert.equal(await hasWorkday('anything'), false);
  });
});
