import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyFilters, applyFiltersDetailed } from '../src/filters.js';

const now = Date.now();
const daysAgo = (n) => new Date(now - n * 86400000).toISOString();

const JOBS = [
  {
    id: '1',
    title: 'Senior Product Manager',
    department: 'Product',
    description: 'Lead growth initiatives and drive roadmap.',
    location: 'San Francisco, CA',
    postedAt: daysAgo(3),
  },
  {
    id: '2',
    title: 'Staff Engineer',
    department: 'Engineering',
    description: 'Build scalable systems. Open to remote US.',
    location: 'New York, NY',
    postedAt: daysAgo(20),
  },
  {
    id: '3',
    title: 'Product Designer',
    department: 'Design',
    description: 'Shape user experience.',
    location: 'London, UK',
    postedAt: daysAgo(5),
  },
  {
    id: '4',
    title: 'Backend Engineer',
    department: 'Engineering',
    description: 'Work on APIs.',
    location: 'Remote - US',
    postedAt: daysAgo(1),
  },
  {
    id: '5',
    title: 'Growth PM',
    department: 'Growth',
    description: 'Own acquisition funnel.',
    location: 'Berlin, Germany',
    postedAt: null,
  },
];

describe('applyFilters — titleFilter', () => {
  test('matches title only', () => {
    const result = applyFilters(JOBS, { titleFilter: 'Product Manager' });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, '1');
  });

  test('does NOT match description mentions (the PM-in-engineer-JD case)', () => {
    // Job 2 description says "Open to remote US" — doesn't mention PM.
    // But add a job that mentions product manager in description only.
    const withPMInDesc = [
      ...JOBS,
      {
        id: '99',
        title: 'Staff Engineer',
        department: 'Engineering',
        description: 'Work closely with the product manager to define APIs.',
        location: 'Remote - US',
        postedAt: daysAgo(2),
      },
    ];
    const result = applyFilters(withPMInDesc, { titleFilter: 'product manager' });
    // Only real PM (id 1) matches, not the engineer whose JD mentions PMs
    assert.equal(result.length, 1);
    assert.equal(result[0].id, '1');
  });

  test('case insensitive', () => {
    const result = applyFilters(JOBS, { titleFilter: 'ENGINEER' });
    assert.equal(result.length, 2);
  });

  test('regex pattern works', () => {
    const result = applyFilters(JOBS, { titleFilter: 'Manager|PM' });
    const ids = result.map(j => j.id).sort();
    assert.deepEqual(ids, ['1', '5']);
  });
});

describe('applyFilters — titleFilter AND filter (the real use case)', () => {
  test('title gate + topic match combines with AND', () => {
    // PM roles that are also about growth
    const result = applyFilters(JOBS, {
      titleFilter: 'Manager|PM',
      filter: 'growth',
    });
    const ids = result.map(j => j.id).sort();
    // Job 1: "Senior Product Manager" title + "growth" in description → matches
    // Job 5: "Growth PM" title → "Growth" in title matches both filters
    assert.deepEqual(ids, ['1', '5']);
  });

  test('title gate excludes roles whose description mentions the role type', () => {
    const withPMInDesc = [
      ...JOBS,
      {
        id: '99',
        title: 'Staff Engineer',
        department: 'Engineering',
        description: 'Collaborate with the product manager on growth initiatives.',
        location: 'Remote - US',
        postedAt: daysAgo(2),
      },
    ];
    // Without titleFilter, old --filter "product manager" would grab job 99
    // With titleFilter, job 99 is correctly excluded
    const result = applyFilters(withPMInDesc, {
      titleFilter: 'product manager',
      filter: 'growth',
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, '1'); // Only the real PM, not the engineer
  });

  test('topic filter still searches description within the title-gated set', () => {
    // Filter on a topic that only appears in descriptions of PM roles
    const result = applyFilters(JOBS, {
      titleFilter: 'Manager',
      filter: 'roadmap',
    });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, '1'); // "Lead growth initiatives and drive roadmap"
  });
});

describe('applyFilters — filter keyword', () => {
  test('matches title', () => {
    const result = applyFilters(JOBS, { filter: 'Product Manager' });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, '1');
  });

  test('matches department', () => {
    const result = applyFilters(JOBS, { filter: 'Engineering' });
    assert.equal(result.length, 2);
    assert.deepEqual(result.map(j => j.id).sort(), ['2', '4']);
  });

  test('matches description (issue #13)', () => {
    const result = applyFilters(JOBS, { filter: 'growth' });
    // Job 1 description mentions "growth", job 5 title mentions "Growth"
    const ids = result.map(j => j.id).sort();
    assert.deepEqual(ids, ['1', '5']);
  });

  test('regex pattern works', () => {
    const result = applyFilters(JOBS, { filter: 'PM|Product Manager' });
    const ids = result.map(j => j.id).sort();
    assert.deepEqual(ids, ['1', '5']);
  });

  test('case insensitive', () => {
    const result = applyFilters(JOBS, { filter: 'PRODUCT' });
    assert.ok(result.length >= 2);
  });
});

describe('applyFilters — postedWithinDays', () => {
  test('keeps jobs posted within N days', () => {
    const result = applyFilters(JOBS, { postedWithinDays: 7 });
    const ids = result.map(j => j.id).sort();
    assert.deepEqual(ids, ['1', '3', '4']);
  });

  test('excludes jobs with null postedAt', () => {
    const result = applyFilters(JOBS, { postedWithinDays: 30 });
    assert.ok(!result.find(j => j.id === '5'));
  });

  test('0 days returns nothing (all jobs are older than 0)', () => {
    const result = applyFilters(JOBS, { postedWithinDays: 0 });
    assert.equal(result.length, 0);
  });

  test('undefined means no date filter', () => {
    const result = applyFilters(JOBS, {});
    assert.equal(result.length, 5);
  });
});

describe('applyFilters — word boundary matching for short location tokens', () => {
  // Tester found a real bug: substring match of "US" matches "Australia",
  // "Brussels", "Belarus", "Lausanne", "Sydney, AUS", and "UK" matches
  // "Ukraine". Short tokens (≤4 chars) must use word-boundary matching to
  // avoid silent false positives.
  const globalJobs = [
    { id: 'us1', title: 'PM', department: 'Eng', location: 'San Francisco, US', postedAt: daysAgo(1) },
    { id: 'us2', title: 'PM', department: 'Eng', location: 'Remote - US', postedAt: daysAgo(1) },
    { id: 'us3', title: 'PM', department: 'Eng', location: 'United States', postedAt: daysAgo(1) },
    { id: 'au1', title: 'PM', department: 'Eng', location: 'Sydney, Australia', postedAt: daysAgo(1) },
    { id: 'au2', title: 'PM', department: 'Eng', location: 'Sydney, AUS', postedAt: daysAgo(1) },
    { id: 'be1', title: 'PM', department: 'Eng', location: 'Brussels, Belgium', postedAt: daysAgo(1) },
    { id: 'by1', title: 'PM', department: 'Eng', location: 'Minsk, Belarus', postedAt: daysAgo(1) },
    { id: 'ch1', title: 'PM', department: 'Eng', location: 'Lausanne, Switzerland', postedAt: daysAgo(1) },
    { id: 'uk1', title: 'PM', department: 'Eng', location: 'London, UK', postedAt: daysAgo(1) },
    { id: 'ua1', title: 'PM', department: 'Eng', location: 'Kyiv, Ukraine', postedAt: daysAgo(1) },
  ];

  test('"US" does NOT match Australia, Brussels, Belarus, Lausanne', () => {
    const result = applyFilters(globalJobs, { locationIncludes: ['US'] });
    const ids = result.map(j => j.id).sort();
    // Should match only us1, us2 — not au1, au2, be1, by1, ch1
    assert.deepEqual(ids, ['us1', 'us2']);
  });

  test('"US" matches locations with US as a proper token', () => {
    const result = applyFilters(globalJobs, { locationIncludes: ['US'] });
    assert.ok(result.find(j => j.id === 'us1'));
    assert.ok(result.find(j => j.id === 'us2'));
  });

  test('"UK" does NOT match Ukraine', () => {
    const result = applyFilters(globalJobs, { locationIncludes: ['UK'] });
    const ids = result.map(j => j.id);
    assert.deepEqual(ids, ['uk1']);
    assert.ok(!ids.includes('ua1'));
  });

  test('"United States" still uses substring match (no regression)', () => {
    const result = applyFilters(globalJobs, { locationIncludes: ['United States'] });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, 'us3');
  });

  test('"AUS" (3-char code) does not leak into words containing "aus"', () => {
    const result = applyFilters(globalJobs, { locationIncludes: ['AUS'] });
    const ids = result.map(j => j.id).sort();
    // Should match only au2 (where "AUS" is a discrete token). NOT au1 (Australia).
    assert.deepEqual(ids, ['au2']);
  });

  test('locationExcludes applies word boundaries too (the symmetric case)', () => {
    // Exclude "UK" should drop London but keep Kyiv, Ukraine
    const result = applyFilters(globalJobs, { locationExcludes: ['UK'] });
    const ids = result.map(j => j.id);
    assert.ok(!ids.includes('uk1'), 'UK job should be excluded');
    assert.ok(ids.includes('ua1'), 'Ukraine should NOT be excluded by UK filter');
  });

  test('Mix: include "United States" + exclude "UK" handles cleanly', () => {
    const result = applyFilters(globalJobs, {
      locationIncludes: ['United States', 'US'],
      locationExcludes: ['UK'],
    });
    const ids = result.map(j => j.id).sort();
    assert.deepEqual(ids, ['us1', 'us2', 'us3']);
  });

  test('5-char tokens keep substring behavior (EMEA, LATAM as qualifiers)', () => {
    const withEmea = [
      ...globalJobs,
      { id: 'e1', title: 'PM', department: 'Eng', location: 'Remote - EMEA', postedAt: daysAgo(1) },
    ];
    const result = applyFilters(withEmea, { locationExcludes: ['EMEA'] });
    assert.ok(!result.find(j => j.id === 'e1'));
  });
});

describe('applyFilters — locationIncludes', () => {
  test('keeps jobs whose location contains any included keyword', () => {
    const result = applyFilters(JOBS, { locationIncludes: ['San Francisco', 'Remote'] });
    const ids = result.map(j => j.id).sort();
    assert.deepEqual(ids, ['1', '4']);
  });

  test('case insensitive', () => {
    const result = applyFilters(JOBS, { locationIncludes: ['remote'] });
    assert.equal(result.length, 1);
    assert.equal(result[0].id, '4');
  });

  test('empty array is treated as no filter', () => {
    const result = applyFilters(JOBS, { locationIncludes: [] });
    assert.equal(result.length, 5);
  });
});

describe('applyFilters — locationExcludes', () => {
  test('drops jobs whose location contains any excluded keyword', () => {
    const result = applyFilters(JOBS, { locationExcludes: ['London', 'Berlin'] });
    const ids = result.map(j => j.id).sort();
    assert.deepEqual(ids, ['1', '2', '4']);
  });

  test('solves the EMEA pollution problem', () => {
    const result = applyFilters(JOBS, {
      locationExcludes: ['UK', 'Germany', 'United Kingdom'],
    });
    const ids = result.map(j => j.id).sort();
    assert.deepEqual(ids, ['1', '2', '4']);
  });

  test('combined with includes', () => {
    const result = applyFilters(JOBS, {
      locationIncludes: ['Remote', 'New York', 'San Francisco', 'London'],
      locationExcludes: ['UK'],
    });
    const ids = result.map(j => j.id).sort();
    assert.deepEqual(ids, ['1', '2', '4']);
  });
});

describe('applyFilters — jobs open in several locations (issue #68)', () => {
  const multi = [
    { id: 'bn', title: 'PM', location: 'Berlin, Germany', locations: ['Berlin, Germany', 'New York, US'], postedAt: daysAgo(1) },
    { id: 'us', title: 'PM', location: 'Austin, TX, US', locations: ['Austin, TX, US', 'Remote - US'], postedAt: daysAgo(1) },
    { id: 'de', title: 'PM', location: 'Munich, Germany', locations: ['Munich, Germany'], postedAt: daysAgo(1) },
    { id: 'legacy', title: 'PM', location: 'London, UK', postedAt: daysAgo(1) },
  ];
  const ids = (opts) => applyFilters(multi, opts).map(j => j.id).sort();

  test('locationIncludes keeps a job when ANY listed location matches', () => {
    assert.deepEqual(ids({ locationIncludes: ['New York'] }), ['bn']);
    assert.deepEqual(ids({ locationIncludes: ['US'] }), ['bn', 'us']);
    assert.deepEqual(ids({ locationIncludes: ['Germany'] }), ['bn', 'de']);
  });

  test('locationExcludes drops a job only when EVERY listed location matches', () => {
    // Open in Berlin and New York is still open in Berlin for someone excluding the US.
    assert.deepEqual(ids({ locationExcludes: ['US'] }), ['bn', 'de', 'legacy']);
    assert.deepEqual(ids({ locationExcludes: ['Germany'] }), ['bn', 'legacy', 'us']);
    assert.deepEqual(ids({ locationExcludes: ['Germany', 'US'] }), ['legacy']);
  });

  test('a job without a locations array is matched on its location string', () => {
    assert.deepEqual(ids({ locationIncludes: ['UK'] }), ['legacy']);
    assert.deepEqual(ids({ locationExcludes: ['UK'] }), ['bn', 'de', 'us']);
  });

  test('includes and excludes compose across the list', () => {
    assert.deepEqual(ids({ locationIncludes: ['Germany'], locationExcludes: ['US'] }), ['bn', 'de']);
    assert.deepEqual(ids({ locationIncludes: ['Germany'], locationExcludes: ['Germany', 'US'] }), []);
  });

  test('word boundaries apply to every entry', () => {
    const jobs = [
      { id: 'au', title: 'PM', location: 'Sydney, Australia', locations: ['Sydney, Australia', 'Brussels, Belgium'], postedAt: daysAgo(1) },
    ];
    assert.deepEqual(applyFilters(jobs, { locationIncludes: ['US'] }), []);
    assert.equal(applyFilters(jobs, { locationExcludes: ['US'] }).length, 1);
  });
});

describe('applyFilters — limit', () => {
  test('caps results at limit', () => {
    const result = applyFilters(JOBS, { limit: 2 });
    assert.equal(result.length, 2);
  });

  test('default limit is 100 (all 5 jobs kept)', () => {
    const result = applyFilters(JOBS, {});
    assert.equal(result.length, 5);
  });

  test('limit applies after filtering', () => {
    const result = applyFilters(JOBS, { filter: 'Engineer', limit: 1 });
    assert.equal(result.length, 1);
  });
});

describe('applyFilters — composed', () => {
  test('all filters together', () => {
    const result = applyFilters(JOBS, {
      filter: 'Engineer|PM|Product',
      postedWithinDays: 10,
      locationIncludes: ['US', 'Remote', 'San Francisco', 'New York'],
      locationExcludes: ['UK'],
      limit: 10,
    });
    const ids = result.map(j => j.id).sort();
    assert.deepEqual(ids, ['1', '4']);
  });
});

describe('applyFilters — order', () => {
  // JOBS by age: 4 (1d), 1 (3d), 3 (5d), 2 (20d), 5 (undated).
  test('default is newest first by postedAt, undated last', () => {
    const ids = applyFilters(JOBS, {}).map(j => j.id);
    assert.deepEqual(ids, ['4', '1', '3', '2', '5']);
  });

  test('ties on postedAt break by id, so pages are deterministic', () => {
    const same = daysAgo(2);
    const tied = [
      { id: 'b', title: 'PM', postedAt: same },
      { id: 'c', title: 'PM', postedAt: same },
      { id: 'a', title: 'PM', postedAt: same },
    ];
    assert.deepEqual(applyFilters(tied, {}).map(j => j.id), ['a', 'b', 'c']);
  });

  test('an unparseable postedAt sorts with the undated', () => {
    const jobs = [
      { id: 'x', title: 'PM', postedAt: 'soon' },
      { id: 'y', title: 'PM', postedAt: daysAgo(30) },
    ];
    assert.deepEqual(applyFilters(jobs, {}).map(j => j.id), ['y', 'x']);
  });

  test("order: 'board' keeps the adapter's order", () => {
    const ids = applyFilters(JOBS, { order: 'board' }).map(j => j.id);
    assert.deepEqual(ids, ['1', '2', '3', '4', '5']);
  });

  test('sort runs before limit, so a cut drops the oldest matches', () => {
    assert.deepEqual(applyFilters(JOBS, { limit: 2 }).map(j => j.id), ['4', '1']);
  });

  test('does not reorder the caller\'s array', () => {
    const input = [...JOBS];
    applyFilters(input, {});
    assert.deepEqual(input.map(j => j.id), ['1', '2', '3', '4', '5']);
  });
});

describe('applyFiltersDetailed — total_matched and offset', () => {
  test('total_matched counts matches before limit', () => {
    const { jobs, total_matched } = applyFiltersDetailed(JOBS, { filter: 'Engineer', limit: 1 });
    assert.equal(jobs.length, 1);
    assert.equal(total_matched, 2);
  });

  test('two pages cover the matched set with no overlap, no gap and the same total', () => {
    const first = applyFiltersDetailed(JOBS, { limit: 3 });
    const second = applyFiltersDetailed(JOBS, { limit: 3, offset: first.jobs.length });
    const ids = [...first.jobs, ...second.jobs].map(j => j.id);
    assert.deepEqual(ids, ['4', '1', '3', '2', '5']);
    assert.equal(first.total_matched, 5);
    assert.equal(second.total_matched, 5);
  });

  test('offset applies after the sort and before limit', () => {
    const { jobs } = applyFiltersDetailed(JOBS, { offset: 1, limit: 2 });
    assert.deepEqual(jobs.map(j => j.id), ['1', '3']);
  });

  test('offset past the end returns an empty page with the total intact', () => {
    const { jobs, total_matched } = applyFiltersDetailed(JOBS, { offset: 10 });
    assert.deepEqual(jobs, []);
    assert.equal(total_matched, 5);
  });

  test('applyFilters returns the same page as an array', () => {
    const opts = { titleFilter: 'Engineer|PM|Manager', offset: 1, limit: 2 };
    assert.deepEqual(applyFilters(JOBS, opts), applyFiltersDetailed(JOBS, opts).jobs);
  });
});
