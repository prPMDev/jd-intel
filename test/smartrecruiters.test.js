import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSmartrecruiters, hasSmartrecruiters } from '../src/adapters/smartrecruiters.js';
import { applyFilters } from '../src/filters.js';
import { disableRetries, isAtsError, probeFailureTests } from './helpers.js';

disableRetries();

/**
 * SmartRecruiters is a two-call adapter (list + per-posting detail).
 * The mock routes by URL: '/postings/<id>' -> detail, '/postings?' -> list.
 * t.mock.method auto-restores per test; no afterEach needed.
 */

const LIST_FIXTURE = {
  offset: 0,
  limit: 100,
  totalFound: 1,
  content: [
    {
      id: '744000111',
      name: 'Staff Product Manager',
      company: { name: 'Test Company' },
      releasedDate: '2026-04-01T10:00:00Z',
      location: {
        city: 'Austin',
        region: 'TX',
        country: 'us',
        remote: false,
        hybrid: true,
        fullLocation: 'Austin, TX, United States',
      },
      department: { label: 'Product' },
      function: { label: 'Product Management' },
      experienceLevel: { label: 'Mid-Senior Level' },
      typeOfEmployment: { label: 'Full-time' },
      refNumber: 'REF123',
    },
  ],
};

const DETAIL_FIXTURE = {
  id: '744000111',
  postingUrl: 'https://jobs.smartrecruiters.com/TestCompany/744000111',
  applyUrl: 'https://jobs.smartrecruiters.com/TestCompany/744000111?oga=true',
  jobAd: {
    sections: {
      jobDescription: { text: '<p>Build cool things. Salary: $150,000 - $200,000.</p>' },
      qualifications: { text: '<p>5 years experience.</p>' },
      additionalInformation: { text: '<p>Great benefits.</p>' },
    },
  },
};

// Trimmed from real detail responses (a fintech and a sports data tenant).
// `compensation` sits at the top level next to jobAd and only appears on
// the detail call; list entries never carry it. Both one-sided shapes occur.
const DETAIL_WITH_RANGE = {
  id: '744000111',
  name: 'Staff Product Manager',
  postingUrl: 'https://jobs.smartrecruiters.com/TestCompany/744000111-staff-product-manager',
  applyUrl: 'https://jobs.smartrecruiters.com/TestCompany/744000111-staff-product-manager?oga=true',
  jobAd: {
    sections: {
      companyDescription: { title: 'Company Description', text: '<p>We move money across borders.</p>' },
      jobDescription: { title: 'Job Description', text: '<p>Own the roadmap for a payments product.</p>' },
      qualifications: { title: 'Qualifications', text: '<p>Shipped B2B products.</p>' },
      additionalInformation: { title: 'Additional Information', text: '<p>Salary: &#xa3;87,500 - &#xa3;111,000 per year.</p>' },
    },
  },
  compensation: { min: 87500, max: 111000, currency: 'GBP', period: 'YEARLY' },
  active: true,
  typeOfEmployment: { id: 'permanent', label: 'Full-time' },
};

const DETAIL_MAX_ONLY = {
  id: '744000152029379',
  name: 'Sports Data Operator (m/f/d)',
  postingUrl: 'https://jobs.smartrecruiters.com/Sportradar/744000152029379-sports-data-operator-m-f-d-',
  applyUrl: 'https://jobs.smartrecruiters.com/Sportradar/744000152029379-sports-data-operator-m-f-d-?oga=true',
  jobAd: {
    sections: {
      companyDescription: { title: 'Company Description', text: '<p><strong>Sportradar </strong>is a sports data partner to the top leagues.&#xa0;</p>' },
      jobDescription: { title: 'Job Description', text: '<p>Collect live match data from the stadium.</p>' },
      qualifications: { title: 'Qualifications', text: '<p>Sports knowledge, fast reactions.</p>' },
      additionalInformation: { title: 'Additional Information', text: '<p>Part-time, shift based.</p>' },
    },
  },
  compensation: { max: 2450, currency: 'EUR', period: 'MONTHLY' },
  active: true,
  typeOfEmployment: { id: 'permanent', label: 'Full-time' },
};

const DETAIL_MIN_ONLY = {
  id: '744000122',
  name: 'Senior Backend Engineer',
  postingUrl: 'https://jobs.smartrecruiters.com/TestCompany/744000122-senior-backend-engineer',
  applyUrl: 'https://jobs.smartrecruiters.com/TestCompany/744000122-senior-backend-engineer?oga=true',
  jobAd: {
    sections: {
      jobDescription: { title: 'Job Description', text: '<p>Build the ledger service.</p>' },
      qualifications: { title: 'Qualifications', text: '<p>Distributed systems experience.</p>' },
    },
  },
  compensation: { min: 520000, currency: 'INR', period: 'YEARLY' },
  active: true,
};

function mockFetch(t, { listStatus = 200, list = LIST_FIXTURE, detail = DETAIL_FIXTURE } = {}) {
  t.mock.method(global, 'fetch', async (url) => {
    if (url.includes('/postings/')) {
      return { ok: true, status: 200, json: async () => detail };
    }
    return {
      ok: listStatus >= 200 && listStatus < 300,
      status: listStatus,
      json: async () => list,
    };
  });
}

describe('fetchSmartrecruiters', () => {
  test('hits the list URL', async (t) => {
    const calls = [];
    t.mock.method(global, 'fetch', async (url) => {
      calls.push(url);
      if (url.includes('/postings/')) return { ok: true, status: 200, json: async () => DETAIL_FIXTURE };
      return { ok: true, status: 200, json: async () => LIST_FIXTURE };
    });

    await fetchSmartrecruiters('testco');

    assert.match(calls[0], /api\.smartrecruiters\.com\/v1\/companies\/testco\/postings\?limit=100/);
  });

  test('returns [] on 404 (company not found)', async (t) => {
    mockFetch(t, { listStatus: 404, list: {} });
    const jobs = await fetchSmartrecruiters('nonexistent');
    assert.deepEqual(jobs, []);
  });

  test('a 5xx on the list throws ats_unreachable carrying the status', async (t) => {
    mockFetch(t, { listStatus: 500, list: {} });
    await assert.rejects(() => fetchSmartrecruiters('testco'), isAtsError('ats_unreachable', 500));
  });

  test('a detail 429 that outlasts the retries keeps the list-only fields', async (t) => {
    // Reporting the missing description is #26; the posting itself survives.
    t.mock.method(global, 'fetch', async (url) => {
      if (url.includes('/postings/')) return { ok: false, status: 429, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => LIST_FIXTURE };
    });
    const [job] = await fetchSmartrecruiters('testco');
    assert.equal(job.title, 'Staff Product Manager');
    assert.equal(job.description, '');
    assert.equal(job.url, '');
  });

  test('detail fetches run at most 4 at a time through the per-host queue', async (t) => {
    const content = Array.from({ length: 10 }, (_, i) => ({ ...LIST_FIXTURE.content[0], id: `74400${i}` }));
    let inFlight = 0;
    let peak = 0;
    t.mock.method(global, 'fetch', async (url) => {
      if (!url.includes('/postings/')) {
        return { ok: true, status: 200, json: async () => ({ ...LIST_FIXTURE, totalFound: 10, content }) };
      }
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(r => setTimeout(r, 5));
      inFlight -= 1;
      return { ok: true, status: 200, json: async () => DETAIL_FIXTURE };
    });
    const jobs = await fetchSmartrecruiters('testco');
    assert.equal(jobs.length, 10);
    assert.equal(peak, 4);
  });

  test('maps a job to the unified schema', async (t) => {
    mockFetch(t);
    const jobs = await fetchSmartrecruiters('testco');

    assert.equal(jobs.length, 1);
    const job = jobs[0];

    assert.equal(job.title, 'Staff Product Manager');
    assert.equal(job.company, 'Test Company');
    assert.equal(job.companySlug, 'testco');
    assert.equal(job.ats, 'smartrecruiters');
    assert.equal(job.department, 'Product');
    assert.equal(job.locationType, 'hybrid');
    assert.equal(job.url, 'https://jobs.smartrecruiters.com/TestCompany/744000111');
    assert.equal(job.postedAt, '2026-04-01T10:00:00Z');
  });

  test('job id is unchanged (location still feeds the id, locations does not)', async (t) => {
    mockFetch(t);
    const [job] = await fetchSmartrecruiters('testco');
    assert.equal(job.id, '5b8eb8b03feb');
  });

  test('location.hybrid and location.remote are the ATS speaking, so workplace.source is ats', async (t) => {
    mockFetch(t);
    const [hybrid] = await fetchSmartrecruiters('testco');
    assert.deepEqual(hybrid.workplace, { type: 'hybrid', source: 'ats' });
    assert.deepEqual(hybrid.locations, ['Hybrid - Austin, TX, United States']);

    const remoteRow = { ...LIST_FIXTURE.content[0], location: { ...LIST_FIXTURE.content[0].location, remote: true, hybrid: false } };
    mockFetch(t, { list: { ...LIST_FIXTURE, content: [remoteRow] } });
    const [remote] = await fetchSmartrecruiters('testco');
    assert.equal(remote.location, 'Remote - Austin, TX, United States');
    assert.deepEqual(remote.workplace, { type: 'remote', source: 'ats' });

    const plainRow = { ...LIST_FIXTURE.content[0], location: { ...LIST_FIXTURE.content[0].location, remote: false, hybrid: false } };
    mockFetch(t, { list: { ...LIST_FIXTURE, content: [plainRow] } });
    const [plain] = await fetchSmartrecruiters('testco');
    assert.deepEqual(plain.workplace, { type: 'unknown', source: null });
    assert.equal(plain.locationType, 'unknown');
  });

  test('falls back to text extraction when the detail has no compensation', async (t) => {
    mockFetch(t);
    const [job] = await fetchSmartrecruiters('testco');
    assert.deepEqual(job.salary, { min: 150000, max: 200000, currency: 'USD', period: 'year', source: 'text' });
  });

  test('maps detail compensation to salary with the period mapped and source ats', async (t) => {
    mockFetch(t, { detail: DETAIL_WITH_RANGE });
    const [job] = await fetchSmartrecruiters('testco');
    assert.deepEqual(job.salary, { min: 87500, max: 111000, currency: 'GBP', period: 'year', source: 'ats' });
  });

  test('keeps a max-only compensation with min null', async (t) => {
    mockFetch(t, { detail: DETAIL_MAX_ONLY });
    const [job] = await fetchSmartrecruiters('testco');
    assert.deepEqual(job.salary, { min: null, max: 2450, currency: 'EUR', period: 'month', source: 'ats' });
  });

  test('keeps a min-only compensation with max null', async (t) => {
    mockFetch(t, { detail: DETAIL_MIN_ONLY });
    const [job] = await fetchSmartrecruiters('testco');
    assert.deepEqual(job.salary, { min: 520000, max: null, currency: 'INR', period: 'year', source: 'ats' });
  });

  test('structured compensation wins over a dollar range in the text', async (t) => {
    const detail = {
      ...DETAIL_WITH_RANGE,
      jobAd: { sections: { jobDescription: { text: '<p>Salary: $150,000 - $200,000.</p>' } } },
    };
    mockFetch(t, { detail });
    const [job] = await fetchSmartrecruiters('testco');
    assert.equal(job.salary.currency, 'GBP');
    assert.equal(job.salary.source, 'ats');
  });

  test('leaves period null when compensation carries no period', async (t) => {
    const detail = { ...DETAIL_WITH_RANGE, compensation: { min: 87500, max: 111000, currency: 'GBP' } };
    mockFetch(t, { detail });
    const [job] = await fetchSmartrecruiters('testco');
    assert.equal(job.salary.period, null);
    assert.equal(job.salary.source, 'ats');
  });

  test('ignores a compensation with neither bound so the text fallback runs', async (t) => {
    const detail = { ...DETAIL_FIXTURE, compensation: { currency: 'GBP', period: 'YEARLY' } };
    mockFetch(t, { detail });
    const [job] = await fetchSmartrecruiters('testco');
    assert.equal(job.salary.source, 'text');
  });

  test('decodes hex entities (&#xa0;) and named entities in the description', async (t) => {
    // SmartRecruiters writes non-breaking spaces as &#xa0; throughout its sections.
    const detail = {
      ...DETAIL_FIXTURE,
      jobAd: { sections: { jobDescription: { text: '<p>5&#xa0;years&#xa0;experience &mdash; &quot;senior&quot; level.</p>' } } },
    };
    mockFetch(t, { detail });
    const [job] = await fetchSmartrecruiters('testco');
    assert.equal(job.description, '5 years experience — "senior" level.');
  });

  test('concatenates jobAd sections into the description', async (t) => {
    mockFetch(t);
    const [job] = await fetchSmartrecruiters('testco');
    assert.match(job.description, /Build cool things/);
    assert.match(job.description, /5 years experience/);
    assert.match(job.description, /Great benefits/);
  });

  test('preserves SmartRecruiters metadata', async (t) => {
    mockFetch(t);
    const [job] = await fetchSmartrecruiters('testco');
    assert.equal(job.metadata.smartRecruitersId, '744000111');
    assert.equal(job.metadata.refNumber, 'REF123');
    assert.equal(job.metadata.function, 'Product Management');
  });

  test('handles empty content array', async (t) => {
    mockFetch(t, { list: { content: [], totalFound: 0 } });
    const jobs = await fetchSmartrecruiters('emptyco');
    assert.deepEqual(jobs, []);
  });
});

// A board of `total` rows, 100 a page, offset read from the list URL. Every
// row starts as LIST_FIXTURE's posting with its own id and "Job <i>" name;
// `rows[i]` overrides fields on the row at index i.
function boardMock(t, total, rows = {}) {
  const calls = { list: 0, detail: 0, detailIds: [] };
  t.mock.method(global, 'fetch', async (url) => {
    if (url.includes('/postings/')) {
      calls.detail += 1;
      calls.detailIds.push(url.slice(url.lastIndexOf('/') + 1));
      return { ok: true, status: 200, json: async () => DETAIL_FIXTURE };
    }
    calls.list += 1;
    const offset = Number(new URL(url).searchParams.get('offset'));
    const content = [];
    for (let i = offset; i < Math.min(offset + 100, total); i++) {
      content.push({ ...LIST_FIXTURE.content[0], id: `id${i}`, name: `Job ${i}`, ...(rows[i] || {}) });
    }
    return { ok: true, status: 200, json: async () => ({ offset, limit: 100, totalFound: total, content }) };
  });
  return calls;
}

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();

describe('fetchSmartrecruiters detail budget (issue #90)', () => {
  test('limit bounds the detail fetches on a 400-row board, in list order', async (t) => {
    const calls = boardMock(t, 400);
    const jobs = await fetchSmartrecruiters('testco', { filterContext: { limit: 1 } });
    assert.equal(calls.list, 4, 'the whole list is still read');
    assert.equal(calls.detail, 1);
    assert.deepEqual(calls.detailIds, ['id0']);
    assert.equal(jobs.length, 1);
  });

  test('offset extends the detail budget to offset + limit', async (t) => {
    const calls = boardMock(t, 400);
    await fetchSmartrecruiters('testco', { filterContext: { limit: 1, offset: 2 } });
    assert.equal(calls.detail, 3);
    assert.deepEqual(calls.detailIds.sort(), ['id0', 'id1', 'id2']);
  });

  test('offset + limit is still capped at 100 detail fetches', async (t) => {
    const calls = boardMock(t, 400);
    await fetchSmartrecruiters('testco', { filterContext: { limit: 50, offset: 80 } });
    assert.equal(calls.detail, 100);
  });

  test('without a filterContext the cap still holds (100 of 400)', async (t) => {
    const calls = boardMock(t, 400);
    const jobs = await fetchSmartrecruiters('testco');
    assert.equal(calls.list, 4);
    assert.equal(calls.detail, 100);
    assert.equal(jobs.length, 100);
  });

  test('a title filter narrows the candidates before hydration', async (t) => {
    const calls = boardMock(t, 400, {
      5: { name: 'Senior Product Manager' },
      250: { name: 'Product Manager, Payments' },
      399: { name: 'Group Product Manager' },
    });
    const jobs = await fetchSmartrecruiters('testco', { filterContext: { titleFilter: 'product manager', limit: 100 } });
    assert.equal(calls.detail, 3);
    assert.deepEqual(calls.detailIds.sort(), ['id250', 'id399', 'id5']);
    assert.deepEqual(jobs.map(j => j.title), ['Senior Product Manager', 'Product Manager, Payments', 'Group Product Manager']);
  });

  test('a description filter hydrates up to the cap, not to limit', async (t) => {
    // The library runs the description regex after this returns, so a
    // tight cut to `limit` could hydrate 10 non-matches and stop.
    const calls = boardMock(t, 400);
    await fetchSmartrecruiters('testco', { filterContext: { filter: 'engineer', limit: 10 } });
    assert.equal(calls.detail, 100);
  });

  test('location_includes runs on the string the adapter builds; a row with no location is out', async (t) => {
    const rows = {
      1: { location: { city: 'Berlin', country: 'Germany', remote: true } },
      2: { location: {} },
      3: { location: { fullLocation: 'Sydney, Australia' } },
      4: { location: { city: 'Denver', region: 'CO', country: 'US' } },
    };
    // Row 0 is the fixture's "Hybrid - Austin, TX, United States". The
    // detail adds no location, so the blank row 2 could never pass
    // applyFilters under includes and hydrating it would waste a slot.
    let calls = boardMock(t, 5, rows);
    await fetchSmartrecruiters('testco', { filterContext: { locationIncludes: ['Remote'], limit: 100 } });
    assert.deepEqual(calls.detailIds, ['id1'], 'the Remote prefix counts, the blank row does not');

    calls = boardMock(t, 5, rows);
    await fetchSmartrecruiters('testco', { filterContext: { locationIncludes: ['United States'], limit: 100 } });
    assert.deepEqual(calls.detailIds, ['id0']);

    calls = boardMock(t, 5, rows);
    await fetchSmartrecruiters('testco', { filterContext: { locationIncludes: ['US'], limit: 100 } });
    assert.deepEqual(calls.detailIds, ['id4'], 'a short token is word-bounded: no Austin or Australia collision');
  });

  test('a blank-location row does not take the hydration slot from a real match', async (t) => {
    // Unbounded hydration returned this job. A pre-filter that kept the
    // blank row would hydrate it alone and hand the library an empty page.
    const calls = boardMock(t, 2, { 0: { location: {} }, 1: { location: { fullLocation: 'London, UK' } } });
    const jobs = await fetchSmartrecruiters('testco', { filterContext: { locationIncludes: ['London'], limit: 1 } });
    assert.deepEqual(calls.detailIds, ['id1']);
    assert.equal(applyFilters(jobs, { locationIncludes: ['London'], limit: 1 }).length, 1);
  });

  test('location_excludes drops matching rows; a row with no location passes', async (t) => {
    const calls = boardMock(t, 4, {
      1: { location: { city: 'Berlin', country: 'Germany', remote: true } },
      2: { location: {} },
      3: { location: { fullLocation: 'Sydney, Australia' } },
    });
    await fetchSmartrecruiters('testco', { filterContext: { locationExcludes: ['Berlin', 'Australia'], limit: 100 } });
    assert.deepEqual(calls.detailIds.sort(), ['id0', 'id2']);
  });

  test('posted_within_days pre-filters on releasedDate; an undated row is out', async (t) => {
    // postedAt comes from releasedDate alone, so the library would drop
    // the undated row after hydration anyway. No detail fetch buys it back.
    const calls = boardMock(t, 3, {
      0: { releasedDate: daysAgo(2) },
      1: { releasedDate: daysAgo(40) },
      2: { releasedDate: undefined },
    });
    const jobs = await fetchSmartrecruiters('testco', { filterContext: { postedWithinDays: 7, limit: 100 } });
    assert.deepEqual(calls.detailIds, ['id0']);
    assert.equal(jobs.length, 1);
  });

  test('reports the scan once: listed, prefiltered, hydrated, capped, plus the org the list states', async (t) => {
    boardMock(t, 400, { 5: { name: 'Product Designer' }, 250: { name: 'Staff Designer' } });
    const reports = [];
    await fetchSmartrecruiters('testco', {
      filterContext: { titleFilter: 'designer', limit: 100 },
      report: (scan) => reports.push(scan),
    });
    assert.deepEqual(reports, [{ listed: 400, prefiltered: 2, hydrated: 2, capped: false, org_name: 'Test Company', org_url: null }]);
  });

  test('the report says capped when the budget cut candidates', async (t) => {
    boardMock(t, 400);
    const reports = [];
    await fetchSmartrecruiters('testco', { filterContext: { limit: 1 }, report: (scan) => reports.push(scan) });
    assert.deepEqual(reports, [{ listed: 400, prefiltered: 400, hydrated: 1, capped: true, org_name: 'Test Company', org_url: null }]);
  });

  test('no report call without a report function, and none on a 404', async (t) => {
    boardMock(t, 2);
    const jobs = await fetchSmartrecruiters('testco', { filterContext: { limit: 100 }, report: undefined });
    assert.equal(jobs.length, 2);

    mockFetch(t, { listStatus: 404, list: {} });
    const reports = [];
    await fetchSmartrecruiters('nonexistent', { report: (scan) => reports.push(scan) });
    assert.deepEqual(reports, [], 'a 404 is not a scan');
  });
});

describe('fetchSmartrecruiters detail failure (issue #85)', () => {
  const failingDetail = (t, detail) => t.mock.method(global, 'fetch', async (url) => {
    if (url.includes('/postings/')) return detail();
    return { ok: true, status: 200, json: async () => LIST_FIXTURE };
  });

  test('a detail 429 keeps the job, marked content missing with the reason', async (t) => {
    failingDetail(t, () => ({ ok: false, status: 429, json: async () => ({}) }));
    const jobs = await fetchSmartrecruiters('TestCo');
    assert.ok(jobs.length > 0);
    for (const job of jobs) {
      assert.deepEqual(job.content, { status: 'missing', reason: 'http_429' });
      assert.equal(job.description, '');
      assert.ok(job.title, 'list fields survive');
    }
  });

  test('a detail that throws is network_error; a detail that loads is complete', async (t) => {
    failingDetail(t, () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }); });
    assert.deepEqual((await fetchSmartrecruiters('TestCo'))[0].content, { status: 'missing', reason: 'network_error' });
    mockFetch(t);
    assert.deepEqual((await fetchSmartrecruiters('TestCo'))[0].content, { status: 'complete', reason: null });
  });
});

describe('fetchSmartrecruiters org identity (issue #58)', () => {
  // Every list row carries `company: { identifier, name }` (live shape,
  // 2026-09-27). Neither the list nor the detail has a company website,
  // and postingUrl is on jobs.smartrecruiters.com, so org_url is null.
  const withCompany = (company) => ({
    ...LIST_FIXTURE,
    content: [{ ...LIST_FIXTURE.content[0], company }],
  });
  const orgOf = (reports) => ({ org_name: reports[0].org_name, org_url: reports[0].org_url });

  test('org_name is the list row company name; org_url stays null', async (t) => {
    mockFetch(t, { list: withCompany({ identifier: 'Wise', name: 'Wise' }) });
    const reports = [];
    await fetchSmartrecruiters('Wise', { report: (r) => reports.push(r) });
    assert.equal(reports.length, 1);
    assert.deepEqual(orgOf(reports), { org_name: 'Wise', org_url: null });
  });

  test('a list without a company object reports null, not the slug', async (t) => {
    mockFetch(t, { list: withCompany(undefined) });
    const reports = [];
    await fetchSmartrecruiters('testco', { report: (r) => reports.push(r) });
    assert.deepEqual(orgOf(reports), { org_name: null, org_url: null });
  });

  test('an empty board reports null, not the slug', async (t) => {
    mockFetch(t, { list: { offset: 0, limit: 100, totalFound: 0, content: [] } });
    const reports = [];
    await fetchSmartrecruiters('testco', { report: (r) => reports.push(r) });
    assert.deepEqual(orgOf(reports), { org_name: null, org_url: null });
  });
});

describe('hasSmartrecruiters', () => {
  test('false for an unknown company (SmartRecruiters returns 200-empty, not 404)', async (t) => {
    t.mock.method(global, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ totalFound: 0, content: [] }) }));
    assert.equal(await hasSmartrecruiters('zzzznotacompany'), false);
  });

  test('true for a company with at least one posting', async (t) => {
    t.mock.method(global, 'fetch', async () => ({ ok: true, status: 200, json: async () => ({ totalFound: 1, content: [{ id: '1' }] }) }));
    assert.equal(await hasSmartrecruiters('testco'), true);
  });

  test('false on a 404', async (t) => {
    t.mock.method(global, 'fetch', async () => ({ ok: false, status: 404, json: async () => ({}) }));
    assert.equal(await hasSmartrecruiters('nope'), false);
  });

  probeFailureTests(hasSmartrecruiters, 'testco');
});
