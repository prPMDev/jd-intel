import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { serialize, planAppend, findCollisions, nameCheck, proposeLabel, applyReview } from '../scripts/registry-lib.mjs';

/**
 * The registry pipeline rules (issue #87 phase 1), on in-memory registries:
 * nothing here reads or writes registry/.
 */

const registry = () => ({
  greenhouse: { eol: '\n', entries: [
    { slug: 'acme', name: 'Acme', sector: 'fintech' },
    { slug: 'hs', name: 'Headroom', sector: 'mental health', company: 'Headroom' },
    { slug: 'headroomsourcing', name: 'Headroom (Sourcing)', sector: 'mental health', company: 'Headroom' },
  ] },
  lever: { eol: '\n', entries: [{ slug: 'globex', name: 'Globex', sector: 'energy' }] },
  workday: { eol: '\n', entries: [
    { slug: 'initech', name: 'Initech', sector: 'it services', config: { tenant: 'initech', env: 'wd5', site: 'Careers' } },
  ] },
});

describe('serialize', () => {
  test('emits company after sector, unpadded, and round-trips', () => {
    const { entries } = registry().greenhouse;
    const text = serialize(entries);
    assert.match(text, /\{"slug": "hs", +"name": "Headroom", +"sector": "mental health", "company": "Headroom"\}/);
    assert.deepEqual(JSON.parse(text), entries, 'every key survives a rewrite');
    assert.equal(serialize(JSON.parse(text)), text);
  });

  test('puts config last and keeps the file line ending', () => {
    const text = serialize([{ slug: 'a', name: 'A', sector: 's', company: 'A Co', config: { tenant: 't', env: 'wd1', site: 'S' } }], '\r\n');
    assert.equal(text, '[\r\n  {"slug": "a", "name": "A", "sector": "s", "company": "A Co", "config": {"tenant": "t", "env": "wd1", "site": "S"}}\r\n]\r\n');
  });
});

describe('planAppend', () => {
  test('appends a survivor that collides with nothing', () => {
    const reg = registry();
    const plan = planAppend(reg, { lever: [{ slug: 'newco', name: 'NewCo', sector: 'saas', extra: 'dropped' }] });
    assert.deepEqual(plan, { added: { lever: ['newco'] }, refused: [], review: [] });
    assert.deepEqual(reg.lever.entries.at(-1), { slug: 'newco', name: 'NewCo', sector: 'saas' });
  });

  test('refuses a board already registered on that ATS, and an entry that cannot be a row', () => {
    const reg = registry();
    const plan = planAppend(reg, {
      greenhouse: [{ slug: 'ACME', name: 'Acme Again', sector: 'fintech' }, { slug: 'nosector', name: 'No Sector' }],
      workday: [{ slug: 'noconfig', name: 'No Config', sector: 'retail' }],
      nosuchats: [{ slug: 'x', name: 'X', sector: 's' }],
    });
    assert.deepEqual(plan.added, {});
    assert.deepEqual(plan.review, []);
    assert.equal(plan.refused.length, 4);
    assert.match(plan.refused[0], /greenhouse\/ACME -> board already registered/);
  });

  test('sets a slug or name collision on another ATS aside for review: not appended, not dropped', () => {
    const reg = registry();
    const before = reg.lever.entries.length;
    const plan = planAppend(reg, {
      lever: [{ slug: 'acme', name: 'Acme Field Sales', sector: 'sales' }, { slug: 'globex2', name: 'Acme', sector: 'fintech' }],
    });
    assert.deepEqual(plan.added, {});
    assert.equal(reg.lever.entries.length, before);
    assert.deepEqual(plan.review.map((r) => [r.candidate.slug, r.collisions.map((c) => `${c.ats}/${c.row.slug}:${c.matched_on}`)]), [
      ['acme', ['greenhouse/acme:slug,name']],
      ['globex2', ['greenhouse/acme:slug,name']],
    ]);
  });

  test('a survivor colliding with one appended earlier in the same run goes to review too', () => {
    const plan = planAppend(registry(), { lever: [{ slug: 'twin', name: 'Twin', sector: 's' }], greenhouse: [{ slug: 'twin', name: 'Twin', sector: 's' }] });
    assert.deepEqual(plan.added, { lever: ['twin'] });
    assert.equal(plan.review.length, 1);
  });

  test('a human-asserted company link appends directly when it keeps one spelling and a distinct name', () => {
    const reg = registry();
    const plan = planAppend(reg, { lever: [{ slug: 'headroomeu', name: 'Headroom Europe', sector: 'mental health', company: 'Headroom' }] });
    assert.deepEqual(plan.added, { lever: ['headroomeu'] });
    assert.equal(reg.lever.entries.at(-1).company, 'Headroom');
  });

  test('an asserted link still goes to review on a different spelling, a repeated name, or a collision outside the company', () => {
    const cases = [
      { greenhouse: [{ slug: 'hr2', name: 'Headroom West', sector: 's', company: 'headroom' }] },
      { greenhouse: [{ slug: 'hr3', name: 'Headroom', sector: 's', company: 'Headroom' }] },
      { lever: [{ slug: 'acme', name: 'Headroom Labs', sector: 's', company: 'Headroom' }] },
    ];
    for (const survivors of cases) {
      const plan = planAppend(registry(), survivors);
      assert.deepEqual(plan.added, {}, JSON.stringify(survivors));
      assert.equal(plan.review.length, 1);
    }
  });

  test('a company that names an unlinked row is a collision, never an automatic link', () => {
    const plan = planAppend(registry(), { lever: [{ slug: 'acmeeu', name: 'Acme Europe', sector: 'fintech', company: 'Acme' }] });
    assert.deepEqual(plan.added, {});
    assert.deepEqual(findCollisions(registry(), { company: 'Acme' }).map((c) => c.row.slug), ['acme']);
  });
});

describe('nameCheck', () => {
  const entry = { name: 'Acme', company: 'Acme Holdings' };
  test('match, ignoring a legal-entity code and corporate suffixes', () => {
    assert.equal(nameCheck('LE0001 Acme GmbH', entry), 'match');
    assert.equal(nameCheck('ACME, Inc.', entry), 'match');
  });
  test('partial when one name contains the other', () => assert.equal(nameCheck('Acme Robotics', entry), 'partial'));
  test('mismatch for a different name', () => assert.equal(nameCheck('Globex', entry), 'mismatch'));
  test('unavailable when the board states none', () => {
    assert.equal(nameCheck(null, entry), 'unavailable');
    assert.equal(nameCheck('', entry), 'unavailable');
  });
});

describe('proposeLabel', () => {
  const live = (name_check) => ({ outcome: 'live', name_check });
  test('migration needs the existing board gone and a name match', () => {
    assert.equal(proposeLabel(live('match'), { outcome: 'gone' }), 'migration');
    assert.equal(proposeLabel(live('partial'), { outcome: 'gone' }), 'unverified');
  });
  test('a board that still answers is a second board, never a migration: empty is not gone', () => {
    assert.equal(proposeLabel(live('match'), { outcome: 'live' }), 'second board');
    assert.equal(proposeLabel(live('partial'), { outcome: 'empty' }), 'second board');
  });
  test('a name mismatch is a stranger', () => assert.equal(proposeLabel(live('mismatch'), { outcome: 'live' }), 'same-name stranger'));
  test('no name, an unread existing board or a missing gate result stays unverified', () => {
    assert.equal(proposeLabel(live('unavailable'), { outcome: 'live' }), 'unverified');
    assert.equal(proposeLabel(live('match'), { outcome: 'transient' }), 'unverified');
    assert.equal(proposeLabel(live('match'), { outcome: 'blocked' }), 'unverified');
    assert.equal(proposeLabel(null, { outcome: 'live' }), 'unverified');
  });
});

describe('applyReview', () => {
  const reviewItem = (reg, ats, candidate) => ({ ats, candidate, collisions: findCollisions(reg, candidate) });

  test('second-board appends the candidate and writes company on both rows', () => {
    const reg = registry();
    const item = reviewItem(reg, 'lever', { slug: 'acmeeu', name: 'Acme Europe', sector: 'fintech', company: 'Acme' });
    const touched = applyReview(reg, item, { as: 'second-board', company: 'Acme' });
    assert.deepEqual(touched.sort(), ['greenhouse', 'lever']);
    assert.equal(reg.greenhouse.entries[0].company, 'Acme');
    assert.deepEqual(reg.lever.entries.at(-1), { slug: 'acmeeu', name: 'Acme Europe', sector: 'fintech', company: 'Acme' });
  });

  test('second-board refuses a row already linked to another company, and needs a company', () => {
    const reg = registry();
    const item = reviewItem(reg, 'lever', { slug: 'hs', name: 'HS Labs', sector: 's' });
    assert.throws(() => applyReview(reg, item, { as: 'second-board', company: 'HS' }), /already has company "Headroom"/);
    assert.throws(() => applyReview(reg, item, { as: 'second-board' }), /needs --company/);
  });

  test('migration removes the existing row and appends its replacement, keeping a company link', () => {
    const reg = registry();
    const item = reviewItem(reg, 'lever', { slug: 'hs', name: 'Headroom', sector: 'mental health' });
    const which = item.collisions.findIndex((c) => c.row.slug === 'hs');
    applyReview(reg, item, { as: 'migration', existing: which });
    assert.ok(!reg.greenhouse.entries.some((r) => r.slug === 'hs'));
    assert.deepEqual(reg.lever.entries.at(-1), { slug: 'hs', name: 'Headroom', sector: 'mental health', company: 'Headroom' });
  });

  test('stranger appends under a disambiguated name and links nothing', () => {
    const reg = registry();
    const item = reviewItem(reg, 'lever', { slug: 'acme', name: 'Acme', sector: 'sales' });
    assert.throws(() => applyReview(reg, item, { as: 'stranger', name: 'Acme' }), /still collides/);
    applyReview(reg, item, { as: 'stranger', name: 'Acme Field Sales' });
    assert.deepEqual(reg.lever.entries.at(-1), { slug: 'acme', name: 'Acme Field Sales', sector: 'sales' });
    assert.equal(reg.greenhouse.entries[0].company, undefined);
  });

  test('refuses a board that is already registered, and an unknown --as', () => {
    const reg = registry();
    assert.throws(() => applyReview(reg, { ats: 'greenhouse', candidate: { slug: 'acme', name: 'X', sector: 's' }, collisions: [] }, { as: 'stranger', name: 'X' }), /already registered/);
    assert.throws(() => applyReview(reg, { ats: 'lever', candidate: { slug: 'q', name: 'Q', sector: 's' }, collisions: [] }, { as: 'merge' }), /--as must be/);
  });
});
