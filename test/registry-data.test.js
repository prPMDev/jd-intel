import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Integrity invariants over the REAL registry/*.json data. Deliberately
// content-independent: no specific company is named, so additions, removals,
// and ATS migrations never break this suite (lookup semantics are covered
// by registry.test.js against fixtures). Reads the files directly so no
// loader cache or env override is involved.

import { ATS_NAMES as PLATFORMS } from '../src/adapters/index.js';
import { norm, serialize } from '../scripts/registry-lib.mjs';

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

  // One row, one board (issue #87). A board is unique by (ats, slug); rows
  // that share a `company` key are boards of one company, and a link can
  // only ever be explicit.
  test('a board is unique by (ats, slug)', async () => {
    for (const p of PLATFORMS) {
      const seen = new Set();
      for (const e of await readRegistry(p)) {
        assert.ok(!seen.has(norm(e.slug)), `duplicate board: ${p}/${e.slug}`);
        seen.add(norm(e.slug));
      }
    }
  });

  test('a row without company has a name no other row uses, and no name reads as a company key', async () => {
    const rows = [];
    for (const p of PLATFORMS) for (const e of await readRegistry(p)) rows.push({ ...e, where: `${p}/${e.slug}` });
    const companyKeys = new Set(rows.filter((r) => r.company).map((r) => norm(r.company)));
    const names = new Map(); // norm(name) -> where, standalone rows only
    for (const r of rows.filter((row) => !row.company)) {
      const n = norm(r.name);
      assert.ok(!names.has(n), `duplicate name: ${r.where} collides with ${names.get(n)}; link them with a company key or disambiguate`);
      assert.ok(!companyKeys.has(n), `${r.where}: name equals a company key but the row is not linked`);
      names.set(n, r.where);
    }
  });

  test('rows sharing a company key agree on its spelling, differ in name per ATS, and are at least two', async () => {
    const companies = new Map(); // norm(company) -> [{ company, name, ats, where }]
    for (const p of PLATFORMS) {
      for (const e of await readRegistry(p)) {
        if (e.company === undefined) continue;
        assert.ok(typeof e.company === 'string' && e.company.length > 0, `${p}/${e.slug}: empty company`);
        const key = norm(e.company);
        companies.set(key, [...(companies.get(key) || []), { company: e.company, name: e.name, ats: p, where: `${p}/${e.slug}` }]);
      }
    }
    for (const rows of companies.values()) {
      assert.ok(rows.length >= 2, `${rows[0].where}: company "${rows[0].company}" links only one row`);
      assert.equal(new Set(rows.map((r) => r.company)).size, 1, `company spelled differently across ${rows.map((r) => r.where).join(', ')}`);
      const perAts = rows.map((r) => `${r.ats}|${norm(r.name)}`);
      assert.equal(new Set(perAts).size, perAts.length, `two boards of "${rows[0].company}" on one ATS share a name`);
    }
  });

  test('the serializer reproduces every registry file byte for byte', async () => {
    for (const p of PLATFORMS) {
      const raw = await readFile(new URL(`../registry/${p}.json`, import.meta.url), 'utf-8');
      assert.equal(serialize(JSON.parse(raw), raw.includes('\r\n') ? '\r\n' : '\n'), raw, `registry/${p}.json is not in append-registry's format`);
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
