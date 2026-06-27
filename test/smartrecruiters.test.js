import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchSmartrecruiters, hasSmartrecruiters } from '../src/adapters/smartrecruiters.js';

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

  test('throws on non-404 error', async (t) => {
    mockFetch(t, { listStatus: 500, list: {} });
    await assert.rejects(
      () => fetchSmartrecruiters('testco'),
      /SmartRecruiters API error for testco: 500/
    );
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

  test('extracts salary from concatenated description text', async (t) => {
    mockFetch(t);
    const [job] = await fetchSmartrecruiters('testco');
    assert.deepEqual(job.salary, { min: 150000, max: 200000, currency: 'USD' });
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
});
