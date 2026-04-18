import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchLever } from '../src/adapters/lever.js';

/**
 * Lever's API returns a bare array of job objects (no wrapper).
 * Each job has a nested `categories` object for team/department/location.
 */

const FIXTURE = [
  {
    id: 'abc-123',
    text: 'Senior Product Manager, Integrations ($150,000 - $200,000)',
    hostedUrl: 'https://jobs.lever.co/testco/abc-123',
    createdAt: 1704067200000,
    descriptionPlain: 'Own the partner integration ecosystem. Build APIs.',
    description: '<p>Own the partner integration ecosystem.</p>',
    categories: {
      department: 'Product',
      team: 'Platform',
      location: 'Remote - US',
      commitment: 'Full-time',
    },
    workplaceType: 'remote',
  },
];

function mockFetch(t, { status = 200, body = FIXTURE } = {}) {
  t.mock.method(global, 'fetch', async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

describe('fetchLever', () => {
  test('hits the correct URL', async (t) => {
    const calls = [];
    t.mock.method(global, 'fetch', async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => FIXTURE };
    });

    await fetchLever('testco');

    assert.equal(calls.length, 1);
    assert.match(calls[0], /api\.lever\.co\/v0\/postings\/testco\?mode=json/);
  });

  test('returns [] on 404', async (t) => {
    mockFetch(t, { status: 404, body: {} });
    const jobs = await fetchLever('nonexistent');
    assert.deepEqual(jobs, []);
  });

  test('throws on non-404 error', async (t) => {
    mockFetch(t, { status: 500, body: {} });
    await assert.rejects(
      () => fetchLever('testco'),
      /Lever API error for testco: 500/
    );
  });

  test('returns [] when response is not an array', async (t) => {
    mockFetch(t, { body: { error: 'unexpected shape' } });
    const jobs = await fetchLever('testco');
    assert.deepEqual(jobs, []);
  });

  test('maps a job to the unified schema', async (t) => {
    mockFetch(t);
    const [job] = await fetchLever('testco');

    assert.equal(job.title, 'Senior Product Manager, Integrations ($150,000 - $200,000)');
    assert.equal(job.ats, 'lever');
    assert.equal(job.companySlug, 'testco');
    assert.equal(job.department, 'Product');
    assert.equal(job.location, 'Remote - US');
    assert.equal(job.locationType, 'remote');
    assert.equal(job.url, 'https://jobs.lever.co/testco/abc-123');
    assert.ok(job.postedAt, 'postedAt converted from createdAt');
  });

  test('company falls back to titlecased slug, NOT team name', async (t) => {
    // Lever's API doesn't return the company name. Earlier versions used
    // `categories.team` as a fallback, which meant company came back as
    // "Platform" instead of "Testco". Fix: use slug.
    mockFetch(t);
    const [job] = await fetchLever('testco');
    assert.equal(job.company, 'Testco');
    assert.notEqual(job.company, 'Platform', 'company should NOT be team name');
  });

  test('extracts salary from title (Lever pattern)', async (t) => {
    mockFetch(t);
    const [job] = await fetchLever('testco');
    assert.deepEqual(job.salary, { min: 150000, max: 200000, currency: 'USD' });
  });

  test('preserves Lever-specific metadata', async (t) => {
    mockFetch(t);
    const [job] = await fetchLever('testco');
    assert.equal(job.metadata.leverId, 'abc-123');
    assert.equal(job.metadata.team, 'Platform');
    assert.equal(job.metadata.commitment, 'Full-time');
    assert.equal(job.metadata.workplaceType, 'remote');
  });

  test('handles empty array response', async (t) => {
    mockFetch(t, { body: [] });
    const jobs = await fetchLever('empty');
    assert.deepEqual(jobs, []);
  });
});
