import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTeamtailor } from '../src/adapters/teamtailor.js';

/**
 * TeamTailor is RSS-based, not JSON. The mock returns text() (not json()).
 * Description is HTML-entity-encoded inside the XML, mirroring the real feed.
 * t.mock.method auto-restores per test; no afterEach needed.
 */

const FIXTURE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:tt="https://teamtailor.com/locations">
  <channel>
    <title>Test Company</title>
    <description>Open jobs</description>
    <link>https://testco.teamtailor.com/jobs</link>
    <item>
      <title>Staff Product Manager</title>
      <link>https://testco.teamtailor.com/jobs/123-staff-pm</link>
      <guid>abc-uuid-123</guid>
      <pubDate>Thu, 23 Apr 2026 09:15:01 +0200</pubDate>
      <description>&lt;p&gt;Build cool things. Salary: $150,000 - $200,000.&lt;/p&gt;&lt;p&gt;Five years experience &amp;amp; great benefits.&lt;/p&gt;</description>
      <remoteStatus>hybrid</remoteStatus>
      <tt:department>Product</tt:department>
      <tt:locations>
        <tt:location>
          <tt:name>Berlin</tt:name>
          <tt:city>Berlin</tt:city>
          <tt:country>Germany</tt:country>
        </tt:location>
      </tt:locations>
    </item>
  </channel>
</rss>`;

function mockFetch(t, { status = 200, body = FIXTURE_XML } = {}) {
  t.mock.method(global, 'fetch', async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  }));
}

describe('fetchTeamtailor', () => {
  test('hits the correct RSS URL', async (t) => {
    const calls = [];
    t.mock.method(global, 'fetch', async (url) => {
      calls.push(url);
      return { ok: true, status: 200, text: async () => FIXTURE_XML };
    });

    await fetchTeamtailor('testco');

    assert.equal(calls.length, 1);
    assert.match(calls[0], /^https:\/\/testco\.teamtailor\.com\/jobs\.rss$/);
  });

  test('returns [] on 404 (no TeamTailor site)', async (t) => {
    mockFetch(t, { status: 404, body: '' });
    const jobs = await fetchTeamtailor('nonexistent');
    assert.deepEqual(jobs, []);
  });

  test('throws on non-404 error', async (t) => {
    mockFetch(t, { status: 500, body: '' });
    await assert.rejects(
      () => fetchTeamtailor('testco'),
      /TeamTailor RSS error for testco: 500/
    );
  });

  test('maps a job to the unified schema', async (t) => {
    mockFetch(t);
    const jobs = await fetchTeamtailor('testco');

    assert.equal(jobs.length, 1);
    const job = jobs[0];

    assert.equal(job.title, 'Staff Product Manager');
    assert.equal(job.company, 'Test Company');
    assert.equal(job.companySlug, 'testco');
    assert.equal(job.ats, 'teamtailor');
    assert.equal(job.department, 'Product');
    assert.equal(job.location, 'Berlin, Germany');
    assert.equal(job.url, 'https://testco.teamtailor.com/jobs/123-staff-pm');
    assert.equal(job.metadata.teamtailorId, 'abc-uuid-123');
  });

  test('converts RFC822 pubDate to ISO', async (t) => {
    mockFetch(t);
    const [job] = await fetchTeamtailor('testco');
    assert.equal(job.postedAt, '2026-04-23T07:15:01.000Z'); // +0200 -> UTC
  });

  test('decodes entity-encoded HTML then strips tags', async (t) => {
    mockFetch(t);
    const [job] = await fetchTeamtailor('testco');
    assert.match(job.description, /Build cool things/);
    assert.match(job.description, /Five years experience & great benefits/); // &amp;amp; -> &
    assert.doesNotMatch(job.description, /<p>/); // tags stripped
  });

  test('extracts salary from decoded description', async (t) => {
    mockFetch(t);
    const [job] = await fetchTeamtailor('testco');
    assert.deepEqual(job.salary, { min: 150000, max: 200000, currency: 'USD', period: 'year', source: 'text' });
  });

  test('falls back to a regional subdomain when base 404s', async (t) => {
    const calls = [];
    t.mock.method(global, 'fetch', async (url) => {
      calls.push(url);
      if (url.includes('.na.teamtailor.com')) {
        return { ok: true, status: 200, text: async () => FIXTURE_XML };
      }
      return { ok: false, status: 404, text: async () => '' };
    });

    const jobs = await fetchTeamtailor('crunchbase');

    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].companySlug, 'crunchbase');
    assert.match(calls[0], /^https:\/\/crunchbase\.teamtailor\.com\/jobs\.rss$/);
    assert.match(calls[1], /^https:\/\/crunchbase\.na\.teamtailor\.com\/jobs\.rss$/);
  });

  test('handles a feed with no items', async (t) => {
    mockFetch(t, { body: '<rss><channel><title>Empty Co</title></channel></rss>' });
    const jobs = await fetchTeamtailor('emptyco');
    assert.deepEqual(jobs, []);
  });
});
