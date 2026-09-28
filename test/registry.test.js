import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { loadRegistry, searchRegistry, findAtsBySlug, findEntryBySlug, detectAts, detectAtsDetailed } from '../src/registry.js';
import { disableRetries, mockFetchByHost, okResponse, statusResponse } from './helpers.js';

disableRetries();

// Registry lookup semantics are asserted against the fixture registry in
// test/fixtures/registry/, not live data, so company additions, removals,
// and ATS migrations never break this suite. Both env vars resolve at call
// time: network path disabled, disk loader pointed at the fixtures. Real
// registry data integrity lives in registry-data.test.js.
process.env.JD_INTEL_REGISTRY_URL = '';
process.env.JD_INTEL_REGISTRY_DIR = fileURLToPath(new URL('./fixtures/registry', import.meta.url));

const ATS_KEYS = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'teamtailor', 'recruitee', 'workday'];

describe('loadRegistry', () => {
  test('loads a single ATS as an array', async () => {
    const companies = await loadRegistry('greenhouse');
    assert.ok(Array.isArray(companies), 'should return an array');
    assert.ok(companies.length > 0, 'greenhouse fixture should not be empty');
  });

  test('each entry has slug and name', async () => {
    const companies = await loadRegistry('greenhouse');
    for (const c of companies) {
      assert.ok(c.slug, `missing slug: ${JSON.stringify(c)}`);
      assert.ok(c.name, `missing name: ${JSON.stringify(c)}`);
    }
  });

  test('returns empty array for unknown ATS', async () => {
    const companies = await loadRegistry('nonexistent-ats');
    assert.deepEqual(companies, []);
  });

  test('loads all ATS platforms when called with no arg', async () => {
    const all = await loadRegistry();
    // Locks the loadRegistry bugfix: every registered ATS must be loaded,
    // not just the original three. Pre-0.5.0 this only loaded
    // greenhouse/lever/ashby, so smartrecruiters/teamtailor/recruitee
    // companies fell through to slow discovery probing and never appeared
    // in search_registry; workday's registry-only routing also needs this.
    for (const ats of ATS_KEYS) {
      assert.ok(all[ats], `${ats} key present`);
      assert.ok(Array.isArray(all[ats]), `${ats} is an array`);
    }
  });
});

describe('searchRegistry', () => {
  test('finds by company name (case-insensitive)', async () => {
    const all = await loadRegistry();
    const firstCompany = all.greenhouse[0];
    const results = await searchRegistry(firstCompany.name.toUpperCase());
    assert.ok(results.some(r => r.slug === firstCompany.slug));
  });

  test('attaches ats field to each result', async () => {
    const all = await loadRegistry();
    const someName = all.greenhouse[0].name;
    const results = await searchRegistry(someName);
    for (const r of results) {
      assert.ok(ATS_KEYS.includes(r.ats));
    }
  });

  test('returns empty array when nothing matches', async () => {
    const results = await searchRegistry('zzzz-no-such-company-zzzz');
    assert.deepEqual(results, []);
  });
});

describe('findAtsBySlug', () => {
  test('returns the ATS name for a known slug', async () => {
    const all = await loadRegistry();
    const first = all.greenhouse[0];
    const ats = await findAtsBySlug(first.slug);
    assert.equal(ats, 'greenhouse');
  });

  test('routes slugs to their platforms', async () => {
    assert.equal(await findAtsBySlug('fixture-gh'), 'greenhouse');
    assert.equal(await findAtsBySlug('fixture-ashby'), 'ashby');
    assert.equal(await findAtsBySlug('fixture-lever'), 'lever');
  });

  test('matches case-insensitively (PascalCase SmartRecruiters slug)', async () => {
    // Registry stores "AcmePay"; callers pass a lowercased/stripped slug.
    // Pre-fix this returned null and every SR company (canonical PascalCase
    // slugs) missed registry routing (fell through to slow 7-adapter
    // discovery probing).
    assert.equal(await findAtsBySlug('acmepay'), 'smartrecruiters');
    assert.equal(await findAtsBySlug('ACMEPAY'), 'smartrecruiters');
  });

  test('returns null for unknown slug', async () => {
    const ats = await findAtsBySlug('zzzz-nonexistent-slug-zzzz');
    assert.equal(ats, null);
  });
});

describe('findEntryBySlug', () => {
  test('returns {ats, entry} with adapter config for a Workday slug', async () => {
    const hit = await findEntryBySlug('fixtureco');
    assert.ok(hit, 'fixtureco should be in the fixture registry');
    assert.equal(hit.ats, 'workday');
    assert.equal(hit.entry.slug, 'fixtureco');
    assert.equal(hit.entry.name, 'Fixture Workday Co');
    assert.deepEqual(hit.entry.config, { tenant: 'fixtureco', env: 'wd0', site: 'FixtureCareers' });
  });

  test('returns the full entry for a non-Workday slug', async () => {
    const hit = await findEntryBySlug('fixture-gh');
    assert.ok(hit);
    assert.equal(hit.ats, 'greenhouse');
    assert.equal(hit.entry.slug, 'fixture-gh');
  });

  test('resolves a PascalCase slug from lowercase and returns canonical casing', async () => {
    const hit = await findEntryBySlug('acmepay');
    assert.ok(hit, 'AcmePay should resolve from "acmepay"');
    assert.equal(hit.ats, 'smartrecruiters');
    assert.equal(hit.entry.slug, 'AcmePay'); // canonical, not the lowercased input
  });

  test('returns null for unknown slug', async () => {
    const hit = await findEntryBySlug('zzzz-nonexistent-slug-zzzz');
    assert.equal(hit, null);
  });
});

describe('detectAtsDetailed (issues #55, #87)', () => {
  const delayed = (ms, resp) => async () => { await new Promise(r => setTimeout(r, ms)); return resp; };

  test('a registry-known Workday company is listed from the registry and never probed there', async (t) => {
    const calls = mockFetchByHost(t, {});
    const { boards, failed } = await detectAtsDetailed('fixtureco');
    assert.deepEqual(boards, [{ ats: 'workday', slug: 'fixtureco', source: 'registry' }]);
    assert.deepEqual(failed, []);
    assert.ok(calls.length > 0, 'the other adapters are still probed');
    assert.ok(calls.every(u => !u.includes('myworkdayjobs.com')), `no Workday request expected, got: ${calls.join(', ')}`);
  });

  test('a registry-known company is not probed on its own ATS, and a live probe elsewhere is listed after it', async (t) => {
    const calls = mockFetchByHost(t, { 'recruitee.com': okResponse({ offers: [] }) });
    const { boards } = await detectAtsDetailed('fixture-gh');
    assert.deepEqual(boards, [
      { ats: 'greenhouse', slug: 'fixture-gh', source: 'registry' },
      { ats: 'recruitee', slug: 'fixturegh', source: 'probe' },
    ]);
    assert.ok(calls.every(u => !u.includes('greenhouse.io')), 'the registry answered for Greenhouse');
    assert.deepEqual(await detectAts('fixture-gh'), [{ ats: 'greenhouse', slug: 'fixture-gh' }, { ats: 'recruitee', slug: 'fixturegh' }]);
  });

  test('a probe 429 is recorded in failed with its code; detectAts still resolves', async (t) => {
    mockFetchByHost(t, { 'lever.co': statusResponse(429) });
    const { boards, failed } = await detectAtsDetailed('nocorp');
    assert.deepEqual(boards, []);
    assert.equal(failed.length, 1);
    assert.equal(failed[0].ats, 'lever');
    assert.equal(failed[0].slug, 'nocorp');
    assert.equal(failed[0].code, 'rate_limited');
    assert.match(failed[0].message, /429/);
    assert.deepEqual(Object.keys(failed[0]).sort(), ['ats', 'code', 'message', 'slug']);
    assert.deepEqual(await detectAts('nocorp'), []);
  });

  test('every probe 404 is the true not-found: empty boards, empty failed', async (t) => {
    mockFetchByHost(t, {});
    assert.deepEqual(await detectAtsDetailed('nocorp'), { boards: [], failed: [] });
  });

  test('boards and failed come back in platform order regardless of response timing', async (t) => {
    mockFetchByHost(t, {
      'greenhouse.io': delayed(40, okResponse()),
      'recruitee.com': okResponse({ offers: [] }),
      'lever.co': delayed(30, statusResponse(429)),
      'ashbyhq.com': statusResponse(503),
    });
    const { boards, failed } = await detectAtsDetailed('nocorp');
    assert.deepEqual(boards.map(b => b.ats), ['greenhouse', 'recruitee']);
    assert.deepEqual(failed.map(f => [f.ats, f.code]), [['lever', 'rate_limited'], ['ashby', 'ats_unreachable']]);
  });
});
