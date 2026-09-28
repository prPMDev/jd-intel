import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchTeamtailor, hasTeamtailor } from '../src/adapters/teamtailor.js';
import { applyFilters } from '../src/filters.js';
import { disableRetries, isAtsError, probeFailureTests } from './helpers.js';

disableRetries();

/**
 * TeamTailor is RSS-based, not JSON. The mock returns text() (not json()).
 * Description is HTML-entity-encoded inside the XML, mirroring the real feed.
 * t.mock.method auto-restores per test; no afterEach needed.
 *
 * EXTRA_ITEMS follow the item shape a live feed returns (2026-09-27):
 * <remoteStatus> is one of none, hybrid, fully, onsite, and each office is
 * a <tt:location> with <tt:name>, an empty <tt:address/>, <tt:zip>,
 * <tt:city> and <tt:country>. The second item lists two offices.
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

const EXTRA_ITEMS = `
    <item>
      <title>Senior Product Designer</title>
      <description>&lt;p&gt;Design the app.&lt;/p&gt;</description>
      <pubDate>Mon, 15 Sep 2026 10:02:11 +0200</pubDate>
      <link>https://testco.teamtailor.com/jobs/456-senior-product-designer</link>
      <remoteStatus>fully</remoteStatus>
      <guid>def-uuid-456</guid>
      <company_name>Test Company</company_name>
      <company_uuid>K5gBpFXnPio</company_uuid>
      <tt:locations>
        <tt:location>
          <tt:name>Zagreb, Croatia</tt:name>
          <tt:address/>
          <tt:zip>10000</tt:zip>
          <tt:city>Zagreb</tt:city>
          <tt:country>Croatia</tt:country>
        </tt:location>
      </tt:locations>
      <tt:department>Design</tt:department>
      <tt:role/>
    </item>
    <item>
      <title>Backend Engineer</title>
      <description>&lt;p&gt;Build the platform.&lt;/p&gt;</description>
      <pubDate>Tue, 16 Sep 2026 08:30:00 +0200</pubDate>
      <link>https://testco.teamtailor.com/jobs/789-backend-engineer</link>
      <remoteStatus>none</remoteStatus>
      <guid>ghi-uuid-789</guid>
      <company_name>Test Company</company_name>
      <company_uuid>K5gBpFXnPio</company_uuid>
      <tt:locations>
        <tt:location>
          <tt:name>Berlin</tt:name>
          <tt:address/>
          <tt:zip>10115</tt:zip>
          <tt:city>Berlin</tt:city>
          <tt:country>Germany</tt:country>
        </tt:location>
        <tt:location>
          <tt:name>Stockholm</tt:name>
          <tt:address/>
          <tt:zip>111 22</tt:zip>
          <tt:city>Stockholm</tt:city>
          <tt:country>Sweden</tt:country>
        </tt:location>
      </tt:locations>
      <tt:department>Engineering</tt:department>
      <tt:role/>
    </item>`;

// The hybrid Berlin item above, then a fully remote item and a two-office item.
const MULTI_XML = FIXTURE_XML.replace('  </channel>', `${EXTRA_ITEMS}\n  </channel>`);

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

  test('a 5xx throws ats_unreachable carrying the status', async (t) => {
    mockFetch(t, { status: 500, body: '' });
    await assert.rejects(() => fetchTeamtailor('testco'), isAtsError('ats_unreachable', 500));
  });

  test('a non-404 status other than 429 or 5xx throws with the adapter message', async (t) => {
    mockFetch(t, { status: 403, body: '' });
    await assert.rejects(() => fetchTeamtailor('testco'), /TeamTailor RSS error for testco: 403/);
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

  test('job id is unchanged (location still feeds the id, locations does not)', async (t) => {
    mockFetch(t);
    const [job] = await fetchTeamtailor('testco');
    assert.equal(job.id, '6838bb6f4121');
  });

  test('remoteStatus maps to workplace: hybrid, fully -> remote, none is no signal', async (t) => {
    mockFetch(t, { body: MULTI_XML });
    const [hybrid, fully, none] = await fetchTeamtailor('testco');
    assert.equal(hybrid.locationType, 'hybrid');
    assert.deepEqual(hybrid.workplace, { type: 'hybrid', source: 'ats' });
    assert.equal(fully.locationType, 'remote');
    assert.deepEqual(fully.workplace, { type: 'remote', source: 'ats' });
    assert.equal(fully.location, 'Zagreb, Croatia', 'no Remote prefix is added to the location');
    assert.equal(none.locationType, 'unknown');
    assert.deepEqual(none.workplace, { type: 'unknown', source: null });
  });

  test('remoteStatus onsite maps to onsite', async (t) => {
    mockFetch(t, { body: FIXTURE_XML.replace('<remoteStatus>hybrid</remoteStatus>', '<remoteStatus>onsite</remoteStatus>') });
    const [job] = await fetchTeamtailor('testco');
    assert.deepEqual(job.workplace, { type: 'onsite', source: 'ats' });
  });

  test('locations lists every tt:location as "city, country", primary first', async (t) => {
    mockFetch(t, { body: MULTI_XML });
    const [single, , multi] = await fetchTeamtailor('testco');
    assert.deepEqual(single.locations, ['Berlin, Germany']);
    assert.equal(multi.location, 'Berlin, Germany');
    assert.deepEqual(multi.locations, ['Berlin, Germany', 'Stockholm, Sweden']);
  });

  test('location_includes matches a secondary office; excludes drop only when every office matches', async (t) => {
    mockFetch(t, { body: MULTI_XML });
    const jobs = await fetchTeamtailor('testco');
    assert.deepEqual(applyFilters(jobs, { locationIncludes: ['Stockholm'] }).map(j => j.title), ['Backend Engineer']);
    assert.deepEqual(
      applyFilters(jobs, { locationExcludes: ['Germany'] }).map(j => j.title).sort(),
      ['Backend Engineer', 'Senior Product Designer'],
      'the Berlin-only role drops, the Berlin/Stockholm role stays'
    );
    assert.deepEqual(applyFilters(jobs, { locationExcludes: ['Germany', 'Sweden'] }).map(j => j.title), ['Senior Product Designer']);
  });

  test('handles a feed with no items', async (t) => {
    mockFetch(t, { body: '<rss><channel><title>Empty Co</title></channel></rss>' });
    const jobs = await fetchTeamtailor('emptyco');
    assert.deepEqual(jobs, []);
  });
});

describe('hasTeamtailor', () => {
  // Routes by host: `byHost` maps a hostname to a status; anything else is a 404.
  function regionalMock(t, byHost) {
    const calls = [];
    t.mock.method(global, 'fetch', async (url, init) => {
      const host = new URL(url).hostname;
      calls.push({ host, method: init.method });
      const status = byHost[host] ?? 404;
      return { ok: status >= 200 && status < 300, status, text: async () => '' };
    });
    return calls;
  }

  test('true when the base host serves the feed, using HEAD', async (t) => {
    const calls = regionalMock(t, { 'testco.teamtailor.com': 200 });
    assert.equal(await hasTeamtailor('testco'), true);
    assert.deepEqual(calls, [{ host: 'testco.teamtailor.com', method: 'HEAD' }]);
  });

  test('a 404 on the base host moves to the regional hosts', async (t) => {
    const calls = regionalMock(t, { 'crunchbase.na.teamtailor.com': 200 });
    assert.equal(await hasTeamtailor('crunchbase'), true);
    assert.deepEqual(calls.map(c => c.host), ['crunchbase.teamtailor.com', 'crunchbase.na.teamtailor.com']);
  });

  test('false only when the base and the na host both answer 404; eu is never probed', async (t) => {
    const calls = regionalMock(t, {});
    assert.equal(await hasTeamtailor('nonexistent'), false);
    assert.deepEqual(calls.map(c => c.host), ['nonexistent.teamtailor.com', 'nonexistent.na.teamtailor.com']);
  });

  test('a 429 on the base host throws instead of moving to the regional host', async (t) => {
    const calls = regionalMock(t, { 'testco.teamtailor.com': 429, 'testco.na.teamtailor.com': 200 });
    await assert.rejects(hasTeamtailor('testco'), isAtsError('rate_limited', 429));
    assert.deepEqual(calls.map(c => c.host), ['testco.teamtailor.com']);
  });

  probeFailureTests(hasTeamtailor, 'testco');
});
