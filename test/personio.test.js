import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchPersonio, hasPersonio } from '../src/adapters/personio.js';
import { disableRetries, isAtsError, probeFailureTests } from './helpers.js';

disableRetries();

/**
 * FIXTURE is trimmed from a real /xml?language=en feed (2026-10-04). Plain
 * fields are entity-encoded text; each section's <value> is HTML in CDATA.
 * The second position has no subcompany, no office and one section.
 */
const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>

<workzag-jobs>

<position>
    <id>2777228</id>
    <subcompany>Test Company Greece P.C.</subcompany>
    <office>Athens, Greece</office>
    <additionalOffices>
        <office>Berlin</office>
    </additionalOffices>
    <department>Sales &amp; Account Management</department>
    <recruitingCategory>Sales</recruitingCategory>
    <name>Country Manager Sales &amp; Account Management (all genders)</name>
    <jobDescriptions>
        <jobDescription>
            <name>Your role &amp; team</name>
            <value>
                <![CDATA[<ul><li style="font-size:14px;">Own the growth plan</li><li>Coach the team</li></ul>]]>
            </value>
        </jobDescription>
        <jobDescription>
            <name>Why us?</name>
            <value>
                <![CDATA[Salary range: €60.000 - €75.000 per year.<br><br>You need &lt;5 years in a similar role.]]>
            </value>
        </jobDescription>
    </jobDescriptions>
    <employmentType>permanent</employmentType>
    <seniority>experienced</seniority>
    <schedule>full-time</schedule>
    <yearsOfExperience>5-7</yearsOfExperience>
    <createdAt>2026-09-01T18:22:28+00:00</createdAt>
</position>

<position>
    <id>183990</id>
    <department>Engineering</department>
    <name>Backend Engineer (Remote)</name>
    <jobDescriptions>
        <jobDescription>
            <name>Your mission</name>
            <value>
                <![CDATA[<p>Build the platform.</p>]]>
            </value>
        </jobDescription>
    </jobDescriptions>
    <createdAt>not-a-date</createdAt>
</position>

</workzag-jobs>`;

const EMPTY_FEED = '<?xml version="1.0" encoding="UTF-8"?>\n\n<workzag-jobs>\n\n\n</workzag-jobs>';

function mockFetch(t, { status = 200, body = FIXTURE } = {}) {
  const calls = [];
  t.mock.method(global, 'fetch', async (url, init) => {
    calls.push({ url: String(url), redirect: init?.redirect });
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  });
  return calls;
}

describe('fetchPersonio', () => {
  test('requests the XML feed without following redirects', async (t) => {
    const calls = mockFetch(t);
    await fetchPersonio('testco');
    assert.deepEqual(calls, [{ url: 'https://testco.jobs.personio.de/xml?language=en', redirect: 'manual' }]);
  });

  test('normalizes a position: decoded fields, every office, sections as headings, pay from the text', async (t) => {
    mockFetch(t);
    const [job] = await fetchPersonio('testco', { companyName: 'Test Company' });
    assert.equal(job.ats, 'personio');
    assert.equal(job.company, 'Test Company', 'the registry name labels the job');
    assert.equal(job.companySlug, 'testco');
    assert.equal(job.title, 'Country Manager Sales & Account Management (all genders)', 'the posting name, not a section name');
    assert.equal(job.department, 'Sales & Account Management');
    assert.equal(job.location, 'Athens, Greece');
    assert.deepEqual(job.locations, ['Athens, Greece', 'Berlin']);
    assert.equal(job.url, 'https://testco.jobs.personio.de/job/2777228');
    assert.equal(job.postedAt, '2026-09-01T18:22:28.000Z');
    assert.match(job.description, /^## Your role & team\n\n- Own the growth plan\n- Coach the team/);
    assert.match(job.description, /## Why us\?/);
    assert.match(job.description, /You need <5 years in a similar role\./, 'text the author escaped survives');
    assert.deepEqual(job.salary, { min: 60000, max: 75000, currency: 'EUR', period: 'year', source: 'text' });
    assert.equal(job.metadata.personioId, '2777228');
    assert.equal(job.metadata.subcompany, 'Test Company Greece P.C.');
    assert.equal(job.metadata.seniority, 'experienced');
    assert.deepEqual(job.content, { status: 'complete', reason: null });
  });

  test('a position with no office, no subcompany and a bad date still normalizes', async (t) => {
    mockFetch(t);
    const job = (await fetchPersonio('testco'))[1];
    assert.equal(job.company, 'testco', 'the slug when no registry name is at hand');
    assert.equal(job.title, 'Backend Engineer (Remote)');
    assert.equal(job.location, '');
    assert.deepEqual(job.locations, []);
    assert.equal(job.postedAt, null);
    assert.equal(job.description, '## Your mission\n\nBuild the platform.');
  });

  test('returns [] for a slug with no career site (307 to personio.com, or 404) and for an empty feed', async (t) => {
    mockFetch(t, { status: 307, body: '' });
    assert.deepEqual(await fetchPersonio('nonexistent'), []);
    mockFetch(t, { status: 404, body: '' });
    assert.deepEqual(await fetchPersonio('nonexistent'), []);
    mockFetch(t, { body: EMPTY_FEED });
    assert.deepEqual(await fetchPersonio('emptyco'), []);
  });

  test('throws an AtsError carrying the status on a 500', async (t) => {
    mockFetch(t, { status: 500, body: '' });
    await assert.rejects(fetchPersonio('testco'), isAtsError('ats_unreachable', 500));
  });

  test('reports the first subcompany as the organization; a missing site reports nothing', async (t) => {
    mockFetch(t);
    const reports = [];
    await fetchPersonio('testco', { report: (r) => reports.push(r) });
    assert.deepEqual(reports, [{ org_name: 'Test Company Greece P.C.', org_url: null }]);
    mockFetch(t, { status: 307, body: '' });
    reports.length = 0;
    await fetchPersonio('nonexistent', { report: (r) => reports.push(r) });
    assert.deepEqual(reports, []);
  });
});

describe('hasPersonio', () => {
  test('true when the feed answers (even empty), false on a redirect or a 404', async (t) => {
    mockFetch(t, { body: EMPTY_FEED });
    assert.equal(await hasPersonio('emptyco'), true);
    mockFetch(t, { status: 307, body: '' });
    assert.equal(await hasPersonio('nonexistent'), false);
    mockFetch(t, { status: 404, body: '' });
    assert.equal(await hasPersonio('nonexistent'), false);
  });

  probeFailureTests(hasPersonio, 'testco');
});
