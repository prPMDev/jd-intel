import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSmartrecruiters, hasSmartrecruiters } from '../src/adapters/smartrecruiters.js';
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
