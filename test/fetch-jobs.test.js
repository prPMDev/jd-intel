import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchJobs } from '../src/index.js';

// Force the on-disk registry so the global fetch mocks below only intercept
// adapter calls, never the (now network-first) registry load.
process.env.JD_INTEL_REGISTRY_URL = '';

/**
 * fetchJobs routing: explicit-ATS config passthrough (Workday reachable
 * without a registry entry), registry fallback on the explicit path,
 * config-over-registry precedence, and canonical-cased slug routing for
 * case-sensitive registries (SmartRecruiters). Mocks global fetch
 * (auto-restored per test by t.mock.method).
 */

const WD_LIST = {
  total: 1,
  jobPostings: [
    { title: 'Product Manager', externalPath: '/job/Remote/PM_R1', locationsText: 'Remote', postedOn: 'Posted Today' },
  ],
};
const WD_DETAIL = { jobPostingInfo: { jobDescription: '<p>Build.</p>', startDate: '2026-05-01', location: 'Remote' } };

function workdayMock(t) {
  const calls = { urls: [] };
  t.mock.method(global, 'fetch', async (url) => {
    calls.urls.push(String(url));
    if (String(url).endsWith('/jobs')) return { ok: true, status: 200, json: async () => WD_LIST };
    return { ok: true, status: 200, json: async () => WD_DETAIL };
  });
  return calls;
}

describe('fetchJobs — Workday config passthrough', () => {
  test('explicit ats=workday + config reaches the adapter with that triple', async (t) => {
    const calls = workdayMock(t);
    const jobs = await fetchJobs({
      company: 'expedia',
      ats: 'workday',
      config: { tenant: 'expedia', env: 'wd108', site: 'search' },
    });
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].title, 'Product Manager');
    assert.ok(
      calls.urls.includes('https://expedia.wd108.myworkdayjobs.com/wday/cxs/expedia/search/jobs'),
      `expected the passthrough triple in the list URL, got: ${calls.urls[0]}`
    );
  });

  test('explicit ats=workday with NO config falls back to registry config', async (t) => {
    const calls = workdayMock(t);
    const jobs = await fetchJobs({ company: 'cisco', ats: 'workday' });
    assert.equal(jobs.length, 1);
    assert.ok(
      calls.urls.includes('https://cisco.wd5.myworkdayjobs.com/wday/cxs/cisco/Cisco_Careers/jobs'),
      `expected registry-fallback triple, got: ${calls.urls[0]}`
    );
  });

  test('explicit config overrides the registry entry', async (t) => {
    const calls = workdayMock(t);
    await fetchJobs({
      company: 'cisco',
      ats: 'workday',
      config: { tenant: 'override', env: 'wd99', site: 'OverrideSite' },
    });
    assert.ok(
      calls.urls.some(u => u.startsWith('https://override.wd99.myworkdayjobs.com/')),
      `expected explicit config to win, got: ${calls.urls[0]}`
    );
    assert.ok(
      !calls.urls.some(u => u.includes('cisco.wd5')),
      'registry config must not be used when explicit config is given'
    );
  });
});

describe('fetchJobs — canonical-cased registry slug routing', () => {
  test('auto-detect routes a PascalCase SmartRecruiters slug from lowercased input', async (t) => {
    const calls = { urls: [] };
    t.mock.method(global, 'fetch', async (url) => {
      calls.urls.push(String(url));
      return { ok: true, status: 200, json: async () => ({ content: [], totalFound: 0 }) };
    });
    const jobs = await fetchJobs({ company: 'visa' }); // no ats -> registry-routed
    assert.deepEqual(jobs, []);
    // Routed via the registry to a single adapter using the canonical
    // 'Visa' (not lowercased 'visa', not 7-adapter discovery probing).
    assert.ok(
      calls.urls.length > 0 && calls.urls.every(u => u.includes('api.smartrecruiters.com')),
      `expected only SmartRecruiters calls (registry-routed), got: ${calls.urls.join(', ')}`
    );
    assert.ok(
      calls.urls.some(u => u.includes('/v1/companies/Visa/postings')),
      `expected canonical 'Visa' in the URL, got: ${calls.urls[0]}`
    );
  });
});
