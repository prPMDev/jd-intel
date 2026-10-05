import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchWorkable, hasWorkable } from '../src/adapters/workable.js';
import { disableRetries, isAtsError, probeFailureTests } from './helpers.js';

disableRetries();

/**
 * FIXTURE is trimmed from a real widget response with details=true
 * (2026-10-04): the account name at the top, one job per row with its HTML
 * description inline.
 */
const FIXTURE = {
  name: 'Test Company',
  description: null,
  jobs: [
    {
      title: 'Data Engineer',
      shortcode: 'E38DB16625',
      code: '',
      employment_type: 'Full-time',
      telecommuting: false,
      department: 'Operations',
      url: 'https://apply.workable.com/j/E38DB16625',
      shortlink: 'https://apply.workable.com/j/E38DB16625',
      published_on: '2026-09-07',
      created_at: '2026-09-01',
      country: 'Greece',
      city: 'Athens',
      state: 'Attica',
      experience: 'Mid-Senior level',
      industry: 'Computer Software',
      locations: [
        { country: 'Greece', countryCode: 'GR', city: 'Athens', region: 'Attica', hidden: false },
        { country: 'Germany', countryCode: 'DE', city: 'Berlin', region: 'Berlin', hidden: false },
        { country: 'France', countryCode: 'FR', city: 'Paris', region: '', hidden: true },
      ],
      description: '<p>Build pipelines &amp; models.</p><ul><li>SQL</li></ul><p>Salary: €60.000 - €80.000 per year.</p>',
    },
    {
      title: 'Support Engineer',
      shortcode: 'A1B2C3D4E5',
      telecommuting: true,
      department: 'Support',
      url: 'https://apply.workable.com/j/A1B2C3D4E5',
      published_on: '',
      created_at: '2026-08-15',
      country: 'France',
      city: 'Paris',
      state: '',
      locations: [],
      description: '<p>Help customers.</p>',
    },
  ],
};

function mockFetch(t, { status = 200, body = FIXTURE } = {}) {
  const calls = [];
  t.mock.method(global, 'fetch', async (url) => {
    calls.push(String(url));
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  });
  return calls;
}

describe('fetchWorkable', () => {
  test('asks the widget endpoint for details in one request', async (t) => {
    const calls = mockFetch(t);
    await fetchWorkable('testco');
    assert.deepEqual(calls, ['https://apply.workable.com/api/v1/widget/accounts/testco?details=true']);
  });

  test('normalizes a job: fields, every visible location, description, pay from the text', async (t) => {
    mockFetch(t);
    const [job] = await fetchWorkable('testco');
    assert.equal(job.ats, 'workable');
    assert.equal(job.company, 'Test Company');
    assert.equal(job.companySlug, 'testco');
    assert.equal(job.title, 'Data Engineer');
    assert.equal(job.department, 'Operations');
    assert.equal(job.location, 'Athens, Attica, Greece');
    assert.deepEqual(job.locations, ['Athens, Attica, Greece', 'Berlin, Berlin, Germany'], 'the hidden location stays out');
    assert.deepEqual(job.workplace, { type: 'unknown', source: null }, 'telecommuting false says nothing');
    assert.equal(job.url, 'https://apply.workable.com/j/E38DB16625');
    assert.equal(job.postedAt, '2026-09-07T00:00:00.000Z');
    assert.match(job.description, /Build pipelines & models\./);
    assert.match(job.description, /- SQL/);
    assert.deepEqual(job.salary, { min: 60000, max: 80000, currency: 'EUR', period: 'year', source: 'text' });
    assert.equal(job.metadata.workableId, 'E38DB16625');
    assert.deepEqual(job.content, { status: 'complete', reason: null });
  });

  test('a telecommuting job is remote from the platform, and falls back to created_at', async (t) => {
    mockFetch(t);
    const job = (await fetchWorkable('testco'))[1];
    assert.equal(job.location, 'Remote - Paris, France');
    assert.deepEqual(job.workplace, { type: 'remote', source: 'ats' });
    assert.equal(job.postedAt, '2026-08-15T00:00:00.000Z');
  });

  test('returns [] on 404 (no account) and for an account with nothing open', async (t) => {
    mockFetch(t, { status: 404, body: {} });
    assert.deepEqual(await fetchWorkable('nonexistent'), []);
    mockFetch(t, { body: { name: 'Empty Co', description: null, jobs: [] } });
    assert.deepEqual(await fetchWorkable('emptyco'), []);
  });

  test('throws an AtsError carrying the status on a 500', async (t) => {
    mockFetch(t, { status: 500, body: {} });
    await assert.rejects(fetchWorkable('testco'), isAtsError('ats_unreachable', 500));
  });

  test('reports the account name the board states; a 404 reports nothing', async (t) => {
    mockFetch(t);
    const reports = [];
    await fetchWorkable('testco', { report: (r) => reports.push(r) });
    assert.deepEqual(reports, [{ org_name: 'Test Company', org_url: null }]);
    mockFetch(t, { status: 404, body: {} });
    reports.length = 0;
    await fetchWorkable('nonexistent', { report: (r) => reports.push(r) });
    assert.deepEqual(reports, []);
  });
});

describe('hasWorkable', () => {
  test('true on 200 (even with nothing open), false on 404', async (t) => {
    const calls = mockFetch(t, { body: { name: 'Empty Co', jobs: [] } });
    assert.equal(await hasWorkable('emptyco'), true);
    assert.deepEqual(calls, ['https://apply.workable.com/api/v1/widget/accounts/emptyco'], 'the probe skips details');
    mockFetch(t, { status: 404, body: {} });
    assert.equal(await hasWorkable('nonexistent'), false);
  });

  probeFailureTests(hasWorkable, 'testco');
});
