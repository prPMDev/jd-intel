import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Network-first registry: fetch the hosted copy, fall back to the bundled
 * on-disk copy on any failure. Each test imports a FRESH module instance
 * (cache-busting query) so the per-process registry cache stays isolated.
 * Tests within a file run sequentially, so setting process.env per test is safe.
 */

describe('registry network-first loading', () => {
  test('uses the hosted copy when the fetch succeeds', async (t) => {
    process.env.JD_INTEL_REGISTRY_URL = 'https://example.test/registry';
    t.mock.method(global, 'fetch', async (url) => {
      assert.ok(String(url).startsWith('https://example.test/registry/'), `unexpected url: ${url}`);
      return { ok: true, status: 200, json: async () => [{ slug: 'acme', name: 'Acme' }] };
    });
    const reg = await import('../src/registry.js?case=network');
    const companies = await reg.loadRegistry('greenhouse');
    assert.deepEqual(companies, [{ slug: 'acme', name: 'Acme' }]);
    assert.equal(reg.getRegistrySource(), 'network');
  });

  test('falls back to the bundled copy when the fetch throws', async (t) => {
    process.env.JD_INTEL_REGISTRY_URL = 'https://example.test/registry';
    t.mock.method(global, 'fetch', async () => { throw new Error('network down'); });
    const reg = await import('../src/registry.js?case=fallback');
    const companies = await reg.loadRegistry('greenhouse');
    assert.ok(Array.isArray(companies) && companies.length > 0, 'should return the on-disk registry');
    assert.ok(companies.every((c) => c.slug), 'on-disk entries have slugs');
    assert.equal(reg.getRegistrySource(), 'disk-fallback');
  });

  test('falls back when the hosted copy returns a non-200', async (t) => {
    process.env.JD_INTEL_REGISTRY_URL = 'https://example.test/registry';
    t.mock.method(global, 'fetch', async () => ({ ok: false, status: 503, json: async () => ({}) }));
    const reg = await import('../src/registry.js?case=non200');
    const companies = await reg.loadRegistry('lever');
    assert.ok(Array.isArray(companies) && companies.length > 0);
    assert.equal(reg.getRegistrySource(), 'disk-fallback');
  });

  test('lookups answer in platform order on the first call, whatever order the files arrive in (issue #87)', async (t) => {
    process.env.JD_INTEL_REGISTRY_URL = 'https://example.test/registry';
    // The same slug in the greenhouse and lever files, with the greenhouse
    // file arriving last. Before the fix the first call in a process walked
    // the files in arrival order and answered lever; every later call,
    // served from the cache, answered greenhouse.
    const rows = {
      greenhouse: [{ slug: 'dup', name: 'Dup on Greenhouse' }],
      lever: [{ slug: 'dup', name: 'Dup on Lever' }],
    };
    t.mock.method(global, 'fetch', async (url) => {
      const platform = String(url).split('/').pop().replace('.json', '');
      if (platform === 'greenhouse') await new Promise((r) => setTimeout(r, 40));
      return { ok: true, status: 200, json: async () => rows[platform] || [] };
    });
    const reg = await import('../src/registry.js?case=order');
    assert.equal(await reg.findAtsBySlug('dup'), 'greenhouse', 'first call');
    assert.equal(await reg.findAtsBySlug('dup'), 'greenhouse', 'second call');
    assert.equal((await reg.findEntryBySlug('dup')).entry.name, 'Dup on Greenhouse');
    assert.deepEqual(
      Object.keys(await reg.loadRegistry()),
      ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'teamtailor', 'recruitee', 'workday']
    );
  });

  test('disk-only when JD_INTEL_REGISTRY_URL is empty (no fetch attempted)', async (t) => {
    process.env.JD_INTEL_REGISTRY_URL = '';
    let fetchCalled = false;
    t.mock.method(global, 'fetch', async () => { fetchCalled = true; throw new Error('should not fetch'); });
    const reg = await import('../src/registry.js?case=disabled');
    const companies = await reg.loadRegistry('ashby');
    assert.equal(fetchCalled, false, 'must not hit the network when disabled');
    assert.ok(Array.isArray(companies) && companies.length > 0);
    assert.equal(reg.getRegistrySource(), 'disk-fallback');
  });
});
