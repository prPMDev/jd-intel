import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAshby } from '../src/adapters/ashby.js';

/**
 * Ashby has two APIs: REST (primary, simpler, has compensation) and GraphQL (fallback).
 * These tests cover the REST path. The adapter falls through to GraphQL if REST
 * returns 0 results or errors — that path is untested here.
 */

const FIXTURE = {
  organizationName: 'Test Company',
  jobs: [
    {
      id: 'xyz-456',
      title: 'Senior Product Manager',
      departmentName: 'Product',
      location: 'Remote - US',
      descriptionHtml: '<p>Build great things.</p>',
      publishedAt: '2026-03-01T12:00:00Z',
      employmentType: 'FullTime',
      isRemote: true,
      teamName: 'Growth',
      compensation: '$150,000 - $200,000',
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

describe('fetchAshby', () => {
  test('hits the REST URL with includeCompensation', async (t) => {
    const calls = [];
    t.mock.method(global, 'fetch', async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => FIXTURE };
    });

    await fetchAshby('testco');

    assert.ok(calls.length >= 1);
    assert.match(calls[0], /api\.ashbyhq\.com\/posting-api\/job-board\/testco\?includeCompensation=true/);
  });

  test('returns [] on REST 404 (falls through to GraphQL, which also fails here)', async (t) => {
    // Both REST and GraphQL fail — final result is []
    t.mock.method(global, 'fetch', async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    }));
    const jobs = await fetchAshby('nonexistent');
    assert.deepEqual(jobs, []);
  });

  test('maps a REST job to the unified schema', async (t) => {
    mockFetch(t);
    const [job] = await fetchAshby('testco');

    assert.equal(job.title, 'Senior Product Manager');
    assert.equal(job.company, 'Test Company');
    assert.equal(job.ats, 'ashby');
    assert.equal(job.department, 'Product');
    assert.equal(job.location, 'Remote - US');
    assert.equal(job.locationType, 'remote');
    assert.equal(job.url, 'https://jobs.ashbyhq.com/testco/xyz-456');
    assert.equal(job.postedAt, '2026-03-01T12:00:00Z');
  });

  test('parses compensation string to salary object', async (t) => {
    mockFetch(t);
    const [job] = await fetchAshby('testco');
    assert.deepEqual(job.salary, { min: 150000, max: 200000, currency: 'USD', period: 'year', source: 'ats' });
  });

  test('reads a dot-grouped EUR compensation string as thousands', async (t) => {
    const body = {
      organizationName: 'Test Company',
      jobs: [{ ...FIXTURE.jobs[0], compensation: '€60.000 - €80.000' }],
    };
    mockFetch(t, { body });
    const [job] = await fetchAshby('testco');
    assert.deepEqual(job.salary, { min: 60000, max: 80000, currency: 'EUR', period: 'year', source: 'ats' });
  });

  test('parses structured compensation object', async (t) => {
    const body = {
      organizationName: 'Test Company',
      jobs: [{
        ...FIXTURE.jobs[0],
        compensation: { min: 120000, max: 180000, currency: 'USD' },
      }],
    };
    mockFetch(t, { body });
    const [job] = await fetchAshby('testco');
    assert.deepEqual(job.salary, { min: 120000, max: 180000, currency: 'USD', period: null, source: 'ats' });
  });

  test('preserves Ashby-specific metadata', async (t) => {
    mockFetch(t);
    const [job] = await fetchAshby('testco');
    assert.equal(job.metadata.ashbyId, 'xyz-456');
    assert.equal(job.metadata.employmentType, 'FullTime');
    assert.equal(job.metadata.isRemote, true);
    assert.equal(job.metadata.team, 'Growth');
  });

  test('handles missing compensation gracefully', async (t) => {
    const body = {
      organizationName: 'Test Company',
      jobs: [{ ...FIXTURE.jobs[0], compensation: null }],
    };
    mockFetch(t, { body });
    const [job] = await fetchAshby('testco');
    assert.equal(job.salary, null);
  });
});
