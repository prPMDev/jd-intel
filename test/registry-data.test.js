import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Integrity invariants over the REAL registry/*.json data. Deliberately
// content-independent: no specific company is named, so additions, removals,
// and ATS migrations never break this suite (lookup semantics are covered
// by registry.test.js against fixtures). Reads the files directly so no
// loader cache or env override is involved.

const PLATFORMS = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'teamtailor', 'recruitee', 'workday'];

// Same normalization as findAtsBySlug in src/registry.js.
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

async function readRegistry(platform) {
  const raw = await readFile(new URL(`../registry/${platform}.json`, import.meta.url), 'utf-8');
  return JSON.parse(raw);
}

describe('registry data integrity', () => {
  test('every platform file parses to a non-empty array', async () => {
    for (const p of PLATFORMS) {
      const entries = await readRegistry(p);
      assert.ok(Array.isArray(entries), `${p}.json should be an array`);
      assert.ok(entries.length > 0, `${p}.json should not be empty`);
    }
  });

  test('every entry has non-empty slug, name, and sector', async () => {
    for (const p of PLATFORMS) {
      for (const e of await readRegistry(p)) {
        for (const field of ['slug', 'name', 'sector']) {
          assert.ok(
            typeof e[field] === 'string' && e[field].length > 0,
            `${p}/${e.slug || '?'}: missing or empty ${field}`
          );
        }
      }
    }
  });

  test('workday entries have a complete config triple; no other platform has config', async () => {
    for (const p of PLATFORMS) {
      for (const e of await readRegistry(p)) {
        if (p === 'workday') {
          for (const key of ['tenant', 'env', 'site']) {
            assert.ok(
              e.config && typeof e.config[key] === 'string' && e.config[key].length > 0,
              `workday/${e.slug}: config.${key} missing or empty`
            );
          }
        } else {
          assert.equal(e.config, undefined, `${p}/${e.slug}: config is Workday-only`);
        }
      }
    }
  });

  test('no duplicate normalized slug or name across platforms (one company, one ATS)', async () => {
    const slugs = new Map(); // norm(slug) -> "platform/slug"
    const names = new Map(); // norm(name) -> "platform/slug"
    for (const p of PLATFORMS) {
      for (const e of await readRegistry(p)) {
        const where = `${p}/${e.slug}`;
        const s = norm(e.slug);
        const n = norm(e.name);
        assert.ok(!slugs.has(s), `duplicate slug: ${where} collides with ${slugs.get(s)}`);
        assert.ok(!names.has(n), `duplicate name: ${where} collides with ${names.get(n)}`);
        slugs.set(s, where);
        names.set(n, where);
      }
    }
  });

  test('docs/registry/ (the hosted Pages copy) is byte-identical to registry/', async () => {
    for (const p of PLATFORMS) {
      const source = await readFile(new URL(`../registry/${p}.json`, import.meta.url), 'utf-8');
      const pages = await readFile(new URL(`../docs/registry/${p}.json`, import.meta.url), 'utf-8');
      assert.equal(pages, source, `docs/registry/${p}.json is out of sync; run: npm run sync:registry-pages`);
    }
  });
});
