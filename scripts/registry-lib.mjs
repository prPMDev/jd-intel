/**
 * Shared registry-file logic for append-registry.mjs, link-registry.mjs and
 * verify-registry.mjs (issue #87 phase 1).
 *
 * A registry row is a board: {slug, name, sector, company?, config?}. A
 * board is unique by (ats, slug). Rows that share a `company` key are
 * boards of one company, and only a human writes that key, in a reviewed
 * PR. Nothing here infers that two rows are one company: a candidate that
 * collides with an existing slug, name or company key is set aside for
 * review, never appended and never dropped.
 *
 * Everything except loadRegistryFiles/writeRegistryFile is pure, so the
 * rules are tested without touching registry/ (test/registry-scripts.test.js).
 */

import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { normSlug as norm } from '../src/registry.js';

export { norm };

function formatEntry(e) {
  const fields = {
    slug: `"slug": ${JSON.stringify(e.slug)},`,
    name: `"name": ${JSON.stringify(e.name)},`,
    sector: `"sector": ${JSON.stringify(e.sector)}`,
  };
  if (e.company) fields.company = `"company": ${JSON.stringify(e.company)}`;
  if (e.config) {
    const { tenant, env, site } = e.config;
    fields.config = `"config": {"tenant": ${JSON.stringify(tenant)}, "env": ${JSON.stringify(env)}, "site": ${JSON.stringify(site)}}`;
  }
  return fields;
}

/**
 * One entry per line, slug and name fields padded so the following field
 * aligns across the whole file (longest field + 1 space). sector, company
 * and config are unpadded. serialize(JSON.parse(file)) reproduces every
 * registry file byte for byte; the data test pins that.
 */
export function serialize(entries, eol = '\n') {
  const rows = entries.map(formatEntry);
  const slugW = Math.max(0, ...rows.map((r) => r.slug.length)) + 1;
  const nameW = Math.max(0, ...rows.map((r) => r.name.length)) + 1;
  const lines = rows.map((r) => {
    let line = `  {${r.slug.padEnd(slugW)}${r.name.padEnd(nameW)}${r.sector}`;
    if (r.company) line += `, ${r.company}`;
    if (r.config) line += `, ${r.config}`;
    return line + '}';
  });
  return `[${eol}${lines.join(`,${eol}`)}${eol}]${eol}`;
}

/** The row as the files store it: known keys only, in file order. */
export function toRow(e) {
  return {
    slug: e.slug,
    name: e.name,
    sector: e.sector,
    ...(e.company ? { company: e.company } : {}),
    ...(e.config ? { config: e.config } : {}),
  };
}

/** @returns {Promise<Record<string, { entries: object[], eol: string }>>} */
export async function loadRegistryFiles(dir) {
  const registry = {};
  for (const f of (await readdir(dir)).filter((name) => name.endsWith('.json'))) {
    const raw = await readFile(join(dir, f), 'utf-8');
    registry[f.replace(/\.json$/, '')] = { entries: JSON.parse(raw), eol: raw.includes('\r\n') ? '\r\n' : '\n' };
  }
  return registry;
}

export async function writeRegistryFile(dir, ats, { entries, eol }) {
  await writeFile(join(dir, `${ats}.json`), serialize(entries, eol));
}

/** Why an entry cannot be a row at all, or null when it can. */
function invalid(ats, e) {
  if (!e.slug || !e.name || !e.sector) return 'missing slug, name, or sector';
  if (ats === 'workday' && !(e.config && e.config.tenant && e.config.env && e.config.site)) {
    return 'workday entry missing config {tenant, env, site}';
  }
  return null;
}

const hasBoard = (registry, ats, slug) => registry[ats].entries.some((row) => norm(row.slug) === norm(slug));

/**
 * Existing rows a candidate collides with: any row, in any file, whose
 * slug, name or company key equals the candidate's slug, name or company
 * key after normalization. `matched_on` names the existing row's fields.
 */
export function findCollisions(registry, candidate) {
  const keys = new Set([candidate.slug, candidate.name, candidate.company].filter(Boolean).map(norm));
  const hits = [];
  for (const [ats, { entries }] of Object.entries(registry)) {
    for (const row of entries) {
      const matched_on = ['slug', 'name', 'company'].filter((field) => row[field] && keys.has(norm(row[field])));
      if (matched_on.length > 0) hits.push({ ats, matched_on, row: toRow(row) });
    }
  }
  return hits;
}

/**
 * Decide what happens to each gate survivor, and append the ones that may
 * be appended (mutates `registry`).
 *
 *   appended: no collision at all, or a candidate whose `company` is an
 *     existing company key (a human asserted the link in the candidates
 *     file) and that collides with no row outside that company.
 *   refused:  cannot be a row (missing fields), no registry file for the
 *     ATS, or the board (ats, slug) is already registered.
 *   review:   every other collision. Neither appended nor dropped.
 *
 * @returns {{ added: Record<string, string[]>, refused: string[], review: object[] }}
 */
export function planAppend(registry, survivorsByAts) {
  const added = {};
  const refused = [];
  const review = [];
  for (const [ats, entries] of Object.entries(survivorsByAts)) {
    for (const e of entries || []) {
      const where = `${ats}/${e.slug || '?'}`;
      if (!registry[ats]) { refused.push(`${where} -> no registry/${ats}.json`); continue; }
      const problem = invalid(ats, e);
      if (problem) { refused.push(`${where} -> ${problem}`); continue; }
      if (hasBoard(registry, ats, e.slug)) { refused.push(`${where} -> board already registered on ${ats}`); continue; }

      let collisions = findCollisions(registry, e);
      const linked = e.company && collisions.some((c) => c.row.company && norm(c.row.company) === norm(e.company));
      if (linked) {
        const siblings = collisions.filter((c) => c.row.company && norm(c.row.company) === norm(e.company));
        const sameString = siblings.every((c) => c.row.company === e.company);
        const nameTaken = siblings.some((c) => c.ats === ats && norm(c.row.name) === norm(e.name));
        // An asserted link only clears collisions inside that company, and
        // only when it keeps the company's one display name and a distinct
        // board name per ATS.
        if (sameString && !nameTaken) collisions = collisions.filter((c) => !siblings.includes(c));
      }
      if (collisions.length > 0) {
        review.push({ ats, candidate: toRow(e), collisions, proposed: null });
        continue;
      }
      registry[ats].entries.push(toRow(e));
      (added[ats] = added[ats] || []).push(e.slug);
    }
  }
  return { added, refused, review };
}

// A leading legal-entity code ("LE0001 Acme") and corporate suffixes say
// nothing about which company a board belongs to.
const LEGAL_CODE = /^\s*[a-z]{2}\d{3,}\b[\s:-]*/i;
const SUFFIXES = /\b(inc|ltd|gmbh|llc|corp|group|holdings)\b\.?/gi;
const stem = (s) => norm(String(s).replace(LEGAL_CODE, '').replace(SUFFIXES, ''));

/**
 * How the name a board states about itself compares with the entry's
 * `name` and `company`: 'match', 'partial' (one contains the other),
 * 'mismatch', or 'unavailable' when the board states none. 'partial' is
 * always a review item: unrelated companies share name roots.
 */
export function nameCheck(boardName, entry) {
  const board = boardName ? stem(boardName) : '';
  if (!board) return 'unavailable';
  const claimed = [entry.name, entry.company].filter(Boolean).map(stem).filter(Boolean);
  if (claimed.some((c) => c === board)) return 'match';
  if (claimed.some((c) => c.includes(board) || board.includes(c))) return 'partial';
  return 'mismatch';
}

/**
 * The label the pipeline proposes for one collision, for a human to
 * confirm. `candidate` and `existing` are gate results ({ outcome,
 * name_check }). 'empty' is not 'gone': a board that still answers is
 * never a migration.
 */
export function proposeLabel(candidate, existing) {
  if (!candidate || !existing || candidate.outcome !== 'live') return 'unverified';
  if (candidate.name_check === 'unavailable') return 'unverified';
  if (candidate.name_check === 'mismatch') return 'same-name stranger';
  if (existing.outcome === 'gone') return candidate.name_check === 'match' ? 'migration' : 'unverified';
  if (existing.outcome === 'live' || existing.outcome === 'empty') return 'second board';
  return 'unverified'; // blocked or transient: the existing board could not be read
}

/**
 * Apply one reviewed item (mutates `registry`). The only edits an existing
 * row can receive are here: a `company` key (second board) or removal in
 * favour of its replacement (migration).
 *
 * @param {object} item - A review item: { ats, candidate, collisions }
 * @param {object} opts
 * @param {'second-board'|'migration'|'stranger'} opts.as
 * @param {string} [opts.company] - second-board: the company's display name
 * @param {string} [opts.name] - stranger: the candidate's disambiguated name
 * @param {number} [opts.existing=0] - migration: which collision is replaced
 * @returns {string[]} The ATS files that changed
 */
export function applyReview(registry, item, { as, company, name, existing = 0 }) {
  const { ats, collisions } = item;
  const candidate = { ...item.candidate };
  if (!registry[ats]) throw new Error(`no registry/${ats}.json`);
  if (hasBoard(registry, ats, candidate.slug)) throw new Error(`${ats}/${candidate.slug} is already registered`);
  const find = (c) => registry[c.ats].entries.find((row) => norm(row.slug) === norm(c.row.slug));
  const touched = new Set([ats]);

  if (as === 'second-board') {
    if (!company) throw new Error('second-board needs --company "<display name>"');
    for (const c of collisions) {
      const row = find(c);
      if (!row) throw new Error(`${c.ats}/${c.row.slug} is no longer in the registry`);
      if (row.company && row.company !== company) throw new Error(`${c.ats}/${row.slug} already has company "${row.company}"`);
      if (c.ats === ats && norm(row.name) === norm(candidate.name)) {
        throw new Error(`two ${ats} boards of one company need distinct names; rename one in the candidate`);
      }
      row.company = company;
      touched.add(c.ats);
    }
    candidate.company = company;
  } else if (as === 'migration') {
    const old = collisions[existing];
    const row = old && find(old);
    if (!row) throw new Error(`collision ${existing} is not in the registry`);
    if (row.company && !candidate.company) candidate.company = row.company;
    registry[old.ats].entries.splice(registry[old.ats].entries.indexOf(row), 1);
    touched.add(old.ats);
  } else if (as === 'stranger') {
    if (!name) throw new Error('stranger needs --name "<disambiguated name>"');
    candidate.name = name;
    delete candidate.company;
    // The slug may repeat across ATS; the name must not read as any
    // existing row's name or company.
    const still = findCollisions(registry, { name }).filter((c) => c.matched_on.some((f) => f !== 'slug'));
    if (still.length > 0) throw new Error(`"${name}" still collides with ${still[0].ats}/${still[0].row.slug}`);
  } else {
    throw new Error('--as must be second-board, migration or stranger');
  }

  registry[ats].entries.push(toRow(candidate));
  return [...touched];
}
