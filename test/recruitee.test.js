import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchRecruitee } from '../src/adapters/recruitee.js';

/**
 * Recruitee is a single-call JSON adapter. Mock returns json().
 * t.mock.method auto-restores per test; no afterEach needed.
 */

const FIXTURE = {
  offers: [
    {
      title: 'Senior Backend Engineer',
      company_name: 'Test Company',
      department: 'Engineering',
      city: 'Amsterdam',
      country: 'Nederland',
      remote: false,
      created_at: '2026-05-13 07:38:11 UTC',
      careers_url: 'https://werkenbij.testco.nl/o/senior-backend-engineer',
      careers_apply_url: 'https://testco.recruitee.com/o/senior-backend-engineer/c/new',
      description: '<h3>About us</h3><p>Build cool things. Salary: $150,000 - $200,000.</p>',
      guid: 'abc-guid-123',
      employment_type_code: 'fulltime_permanent',
      category_code: 'engineering',
    },
  ],
};

function mockFetch(t, { status = 200, body = FIXTURE } = {}) {
  t.mock.method(global, 'fetch', async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

describe('fetchRecruitee', () => {
  test('hits the correct URL', async (t) => {
    const calls = [];
    t.mock.method(global, 'fetch', async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => FIXTURE };
    });

    await fetchRecruitee('testco');

    assert.equal(calls.length, 1);
    assert.match(calls[0], /^https:\/\/testco\.recruitee\.com\/api\/offers\/$/);
  });

  test('returns [] on 404 (no Recruitee site)', async (t) => {
    mockFetch(t, { status: 404, body: {} });
    const jobs = await fetchRecruitee('nonexistent');
    assert.deepEqual(jobs, []);
  });

  test('throws on non-404 error', async (t) => {
    mockFetch(t, { status: 500, body: {} });
    await assert.rejects(
      () => fetchRecruitee('testco'),
      /Recruitee API error for testco: 500/
    );
  });

  test('maps an offer to the unified schema', async (t) => {
    mockFetch(t);
    const jobs = await fetchRecruitee('testco');

    assert.equal(jobs.length, 1);
    const job = jobs[0];

    assert.equal(job.title, 'Senior Backend Engineer');
    assert.equal(job.company, 'Test Company');
    assert.equal(job.companySlug, 'testco');
    assert.equal(job.ats, 'recruitee');
    assert.equal(job.department, 'Engineering');
    assert.equal(job.location, 'Amsterdam, Nederland');
    assert.equal(job.url, 'https://werkenbij.testco.nl/o/senior-backend-engineer');
    assert.equal(job.metadata.recruiteeId, 'abc-guid-123');
  });

  test('converts Recruitee timestamp to ISO', async (t) => {
    mockFetch(t);
    const [job] = await fetchRecruitee('testco');
    assert.equal(job.postedAt, '2026-05-13T07:38:11.000Z');
  });

  test('extracts salary from description text', async (t) => {
    mockFetch(t);
    const [job] = await fetchRecruitee('testco');
    assert.deepEqual(job.salary, { min: 150000, max: 200000, currency: 'USD', period: 'year', source: 'text' });
  });

  test('strips HTML once: attributed <li> bullets and escaped text survive', async (t) => {
    mockFetch(t, {
      body: { offers: [{ ...FIXTURE.offers[0], description: '<ul><li class="req">C++ and &lt;5 years</li><li>Dutch is a plus</li></ul>' }] },
    });
    const [job] = await fetchRecruitee('testco');
    assert.equal(job.description, '- C++ and <5 years\n- Dutch is a plus');
  });

  test('prefixes remote locations', async (t) => {
    mockFetch(t, {
      body: { offers: [{ ...FIXTURE.offers[0], remote: true }] },
    });
    const [job] = await fetchRecruitee('testco');
    assert.equal(job.location, 'Remote - Amsterdam, Nederland');
    assert.equal(job.locationType, 'remote');
  });

  test('handles empty offers array', async (t) => {
    mockFetch(t, { body: { offers: [] } });
    const jobs = await fetchRecruitee('emptyco');
    assert.deepEqual(jobs, []);
  });
});
