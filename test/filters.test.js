import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { applyFilters } from '../src/filters.js';

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
