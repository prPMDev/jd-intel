import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchAshby } from '../src/adapters/ashby.js';
import { applyFilters } from '../src/filters.js';

/**
 * Ashby has two APIs: REST (primary, has compensation) and GraphQL (fallback).
 * These tests cover the REST path. The adapter falls through to GraphQL if REST
 * returns 0 results or errors; that path is untested here.
 *
 * FIXTURE is trimmed from a real /posting-api/job-board response with
 * includeCompensation=true (2026-09-27). Top-level keys are `jobs` and
 * `apiVersion` only; there is no organization name. Jobs carry `department`
 * and `team`, and `compensation` is always an object: structured entries in
 * `summaryComponents`, rendered strings in the two summaries. A job with no
 * published pay still gets the object, with null summaries and empty arrays.
 * Descriptions are shortened; markup and field names are as returned.
 */

const FIXTURE = {
  jobs: [
    {
      id: '34413f8d-26bf-4bbc-8ade-eb309a0e2245',
      title: ' Security Engineer, Cloud',
      department: 'Engineering',
      team: 'Backend',
      employmentType: 'FullTime',
      location: 'New York, NY (HQ)',
      shouldDisplayCompensationOnJobPostings: true,
      secondaryLocations: [
        { location: 'Remote (US)', address: { postalAddress: { addressCountry: 'United States' } } },
      ],
      publishedAt: '2026-04-07T17:12:35.753+00:00',
      isListed: true,
      isRemote: true,
      workplaceType: 'Hybrid',
      jobUrl: 'https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245',
      applyUrl: 'https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245/application',
      descriptionHtml: '<h1><strong>About Ramp</strong></h1><p style="min-height:1.5em">Ramp is building the smart infrastructure for finance teams, embedded in the transaction flow of every dollar a business spends.</p>',
      descriptionPlain: 'ABOUT RAMP\n\nRamp is building the smart infrastructure for finance teams, embedded in the transaction flow of every dollar a business spends.',
      compensation: {
        compensationTierSummary: '$211.4K – $290.6K • Offers Equity',
        scrapeableCompensationSalarySummary: '$211.4K - $290.6K',
        compensationTiers: [
          {
            id: '5f7a903e-36e4-492c-ac09-f2745d717daa',
            tierSummary: '$211.4K – $290.6K • Offers Equity',
            title: null,
            additionalInformation: null,
            components: [
              { id: 'feaef96f-559f-4df8-a38c-3eee072a8d74', summary: 'Offers Equity', compensationType: 'EquityPercentage', interval: 'NONE', currencyCode: null, minValue: null, maxValue: null },
              { id: '3481c194-45fd-4b89-8592-e8f4d4b51f20', summary: '$211.4K – $290.6K', compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 211400, maxValue: 290600 },
            ],
          },
        ],
        summaryComponents: [
          { compensationType: 'EquityPercentage', interval: 'NONE', currencyCode: null, minValue: null, maxValue: null },
          { compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 211400, maxValue: 290600 },
        ],
      },
    },
    {
      id: '4e6fffef-bb23-4623-ad86-95b840dd51be',
      title: 'Director, Partnerships',
      department: 'Sales',
      team: 'Channel Sales',
      employmentType: 'FullTime',
      location: 'London',
      shouldDisplayCompensationOnJobPostings: false,
      secondaryLocations: [],
      publishedAt: '2026-09-10T16:59:54.968+00:00',
      isListed: true,
      isRemote: false,
      workplaceType: 'OnSite',
      jobUrl: 'https://jobs.ashbyhq.com/ramp/4e6fffef-bb23-4623-ad86-95b840dd51be',
      applyUrl: 'https://jobs.ashbyhq.com/ramp/4e6fffef-bb23-4623-ad86-95b840dd51be/application',
      descriptionHtml: '<h1><strong>About Ramp</strong></h1><p style="min-height:1.5em">Ramp is building the smart infrastructure for finance teams, embedded in the transaction flow of every dollar a business spends.</p>',
      descriptionPlain: 'ABOUT RAMP\n\nRamp is building the smart infrastructure for finance teams, embedded in the transaction flow of every dollar a business spends.',
      compensation: {
        compensationTierSummary: null,
        scrapeableCompensationSalarySummary: null,
        compensationTiers: [],
        summaryComponents: [],
      },
    },
    {
      id: '397d2098-59c4-4987-9ca9-ec019c37000e',
      title: 'Senior Credit Underwriter | UK',
      department: 'Risk',
      team: 'Risk',
      employmentType: 'FullTime',
      location: 'London',
      shouldDisplayCompensationOnJobPostings: true,
      secondaryLocations: [],
      publishedAt: '2026-06-30T19:45:52.993+00:00',
      isListed: true,
      isRemote: false,
      workplaceType: 'OnSite',
      jobUrl: 'https://jobs.ashbyhq.com/ramp/397d2098-59c4-4987-9ca9-ec019c37000e',
      applyUrl: 'https://jobs.ashbyhq.com/ramp/397d2098-59c4-4987-9ca9-ec019c37000e/application',
      descriptionHtml: '<h1><strong>About Ramp</strong></h1><p style="min-height:1.5em">Ramp is building the smart infrastructure for finance teams, embedded in the transaction flow of every dollar a business spends.</p>',
      descriptionPlain: 'ABOUT RAMP\n\nRamp is building the smart infrastructure for finance teams, embedded in the transaction flow of every dollar a business spends.',
      compensation: {
        compensationTierSummary: '£74K – £100K • Offers Equity',
        scrapeableCompensationSalarySummary: '£74K - £100K',
        compensationTiers: [
          {
            id: 'a005f46e-bd9d-4801-a378-b3418e469159',
            tierSummary: '£74K – £100K • Offers Equity',
            title: null,
            additionalInformation: null,
            components: [
              { id: '2c206441-814a-4dd8-80dc-e8095110abcb', summary: 'Offers Equity', compensationType: 'EquityCashValue', interval: '1 YEAR', currencyCode: 'GBP', minValue: null, maxValue: null },
              { id: 'a859eaa1-3765-4581-b950-dfc149f8e955', summary: '£74K – £100K', compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'GBP', minValue: 74000, maxValue: 100000 },
            ],
          },
        ],
        summaryComponents: [
          { compensationType: 'EquityCashValue', interval: '1 YEAR', currencyCode: 'GBP', minValue: null, maxValue: null },
          { compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'GBP', minValue: 74000, maxValue: 100000 },
        ],
      },
    },
  ],
  apiVersion: 1,
};

const [USD_JOB, NO_PAY_JOB, GBP_JOB] = FIXTURE.jobs;

// An internship from the same board: a single monthly figure, no scrapeable summary.
const MONTHLY_COMPENSATION = {
  compensationTierSummary: '$12.5K per month',
  scrapeableCompensationSalarySummary: null,
  compensationTiers: [
    {
      id: 'f978518c-c151-4ec7-99fa-0e895f2b442a',
      tierSummary: '$12.5K per month',
      title: null,
      additionalInformation: null,
      components: [
        { id: '1fdc3c25-196e-48bc-9060-62fd10523930', summary: '$12.5K per month', compensationType: 'Salary', interval: '1 MONTH', currencyCode: 'USD', minValue: 12500, maxValue: 12500 },
      ],
    },
  ],
  summaryComponents: [
    { compensationType: 'Salary', interval: '1 MONTH', currencyCode: 'USD', minValue: 12500, maxValue: 12500 },
  ],
};

// A sales role from the same board: two location tiers labelled OTE. The
// top-level Salary entry spans both tiers.
const TIERED_COMPENSATION = {
  compensationTierSummary: '$131K – $191K • Offers Equity • Offers Commission • Multiple Ranges',
  scrapeableCompensationSalarySummary: '$131K - $191K',
  compensationTiers: [
    {
      id: 'eb6269bc-c162-4fde-87ef-234fe3046814',
      tierSummary: 'The listed range reflects total OTE with a 60/40 base-to-commission split. $145K – $191K • Offers Equity • Offers Commission • 60/40 split',
      title: 'NY/SF',
      additionalInformation: '60/40 split',
      components: [
        { id: 'af228559-d655-4089-ab0a-cb5639a3195c', summary: 'Offers Commission', compensationType: 'Commission', interval: '1 YEAR', currencyCode: 'USD', minValue: null, maxValue: null },
        { id: '5967792b-f3e2-4cf3-a86c-15c6c2f1d2c4', summary: 'The listed range reflects total OTE with a 60/40 base-to-commission split. $145K – $191K', compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 145000, maxValue: 191000 },
      ],
    },
    {
      id: 'c7c2a021-4ed0-476f-9ff9-6e12cb95adb7',
      tierSummary: 'The listed range reflects total OTE with a 60/40 base-to-commission split. $131K – $171K • Offers Equity • Offers Commission • 60/40 split',
      title: 'Nationwide',
      additionalInformation: '60/40 split',
      components: [
        { id: 'e8cff34a-dcc2-4e87-8394-b7e3ec1b0cbb', summary: 'Offers Commission', compensationType: 'Commission', interval: '1 YEAR', currencyCode: 'USD', minValue: null, maxValue: null },
        { id: '3557ebfd-c79d-45d6-af60-4bc3beb66046', summary: 'The listed range reflects total OTE with a 60/40 base-to-commission split. $131K – $171K', compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 131000, maxValue: 171000 },
      ],
    },
  ],
  summaryComponents: [
    { compensationType: 'Commission', minValue: null, maxValue: null, interval: '1 YEAR' },
    { compensationType: 'EquityCashValue', minValue: null, maxValue: null, interval: '1 YEAR' },
    { minValue: 131000, maxValue: 191000, currencyCode: 'USD', interval: '1 YEAR', compensationType: 'Salary' },
  ],
};

// A pay paragraph as another job on the board writes it, for the text fallback.
const PAY_TEXT_HTML = '<p style="min-height:1.5em">Analyst: $108,000 to $148,000</p>';

function mockFetch(t, { status = 200, body = FIXTURE } = {}) {
  t.mock.method(global, 'fetch', async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }));
}

const withJobs = (...jobs) => ({ ...FIXTURE, jobs });

describe('fetchAshby', () => {
  test('hits the REST URL with includeCompensation', async (t) => {
    const calls = [];
    t.mock.method(global, 'fetch', async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => FIXTURE };
    });

    await fetchAshby('ramp');

    assert.ok(calls.length >= 1);
    assert.match(calls[0], /api\.ashbyhq\.com\/posting-api\/job-board\/ramp\?includeCompensation=true/);
  });

  test('returns [] on REST 404 (falls through to GraphQL, which also fails here)', async (t) => {
    // Both REST and GraphQL fail, so the final result is []
    t.mock.method(global, 'fetch', async () => ({
      ok: false,
      status: 404,
      json: async () => ({}),
    }));
    const jobs = await fetchAshby('nonexistent');
    assert.deepEqual(jobs, []);
  });

  test('maps a REST job to the unified schema', async (t) => {
    mockFetch(t);
    const [job] = await fetchAshby('ramp');

    assert.equal(job.title, ' Security Engineer, Cloud');
    assert.equal(job.companySlug, 'ramp');
    assert.equal(job.ats, 'ashby');
    assert.equal(job.department, 'Engineering');
    assert.equal(job.location, 'New York, NY (HQ)');
    assert.equal(job.locationType, 'hybrid');
    assert.equal(job.url, 'https://jobs.ashbyhq.com/ramp/34413f8d-26bf-4bbc-8ade-eb309a0e2245');
    assert.equal(job.postedAt, '2026-04-07T17:12:35.753+00:00');
    assert.equal(job.description, '## About Ramp\n\nRamp is building the smart infrastructure for finance teams, embedded in the transaction flow of every dollar a business spends.');
  });

  test('reads department and team from every job', async (t) => {
    mockFetch(t);
    const jobs = await fetchAshby('ramp');

    assert.deepEqual(jobs.map(j => j.department), ['Engineering', 'Sales', 'Risk']);
    assert.deepEqual(jobs.map(j => j.metadata.team), ['Backend', 'Channel Sales', 'Risk']);
  });

  test('maps the Salary summary component to salary with its interval', async (t) => {
    mockFetch(t);
    const [job] = await fetchAshby('ramp');
    assert.deepEqual(job.salary, { min: 211400, max: 290600, currency: 'USD', period: 'year', source: 'ats' });
  });

  test('keeps the currency the ATS states', async (t) => {
    mockFetch(t);
    const [, , job] = await fetchAshby('ramp');
    assert.deepEqual(job.salary, { min: 74000, max: 100000, currency: 'GBP', period: 'year', source: 'ats' });
  });

  test('maps a "1 MONTH" interval to period month', async (t) => {
    mockFetch(t, { body: withJobs({ ...USD_JOB, compensation: MONTHLY_COMPENSATION }) });
    const [job] = await fetchAshby('ramp');
    assert.deepEqual(job.salary, { min: 12500, max: 12500, currency: 'USD', period: 'month', source: 'ats' });
  });

  test('empty compensation object falls back to the description text', async (t) => {
    mockFetch(t);
    const [, job] = await fetchAshby('ramp');
    assert.equal(job.salary, null);
    assert.equal(job.metadata.compensationSummary, '');
    assert.deepEqual(job.metadata.compensationTiers, []);
  });

  test('text fallback runs when the compensation object is empty', async (t) => {
    mockFetch(t, { body: withJobs({ ...NO_PAY_JOB, descriptionHtml: PAY_TEXT_HTML }) });
    const [job] = await fetchAshby('ramp');
    assert.deepEqual(job.salary, { min: 108000, max: 148000, currency: 'USD', period: 'year', source: 'text' });
  });

  test('Salary component wins over a narrower range in the description', async (t) => {
    mockFetch(t, { body: withJobs({ ...USD_JOB, descriptionHtml: PAY_TEXT_HTML }) });
    const [job] = await fetchAshby('ramp');
    assert.equal(job.salary.source, 'ats');
    assert.equal(job.salary.min, 211400);
  });

  test('parses the scrapeable summary when no Salary component is present', async (t) => {
    const compensation = {
      ...NO_PAY_JOB.compensation,
      compensationTierSummary: '$131K – $191K • Offers Equity • Offers Commission • Multiple Ranges',
      scrapeableCompensationSalarySummary: '$131K - $191K',
    };
    mockFetch(t, { body: withJobs({ ...NO_PAY_JOB, compensation }) });
    const [job] = await fetchAshby('ramp');
    assert.deepEqual(job.salary, { min: 131000, max: 191000, currency: 'USD', period: 'year', source: 'ats' });
  });

  test('handles a job with no compensation key', async (t) => {
    const { compensation, ...job } = NO_PAY_JOB;
    mockFetch(t, { body: withJobs(job) });
    const [result] = await fetchAshby('ramp');
    assert.equal(result.salary, null);
    assert.equal(result.metadata.compensationSummary, '');
  });

  test('preserves Ashby-specific metadata', async (t) => {
    mockFetch(t);
    const [job] = await fetchAshby('ramp');
    assert.equal(job.metadata.ashbyId, '34413f8d-26bf-4bbc-8ade-eb309a0e2245');
    assert.equal(job.metadata.employmentType, 'FullTime');
    assert.equal(job.metadata.isRemote, true);
    assert.equal(job.metadata.team, 'Backend');
    assert.equal(job.metadata.compensationSummary, '$211.4K – $290.6K • Offers Equity');
    assert.deepEqual(job.metadata.compensationTiers, [
      { title: '', summary: '$211.4K – $290.6K • Offers Equity', additionalInformation: '' },
    ]);
  });

  test('job ids are unchanged (location still feeds the id, locations does not)', async (t) => {
    mockFetch(t);
    const jobs = await fetchAshby('ramp');
    assert.deepEqual(jobs.map(j => j.id), ['3fde1ff595a1', '906b668c2b8b', 'e68d6026cb20']);
  });

  test('workplaceType wins over a location string with no keyword and over isRemote', async (t) => {
    // "New York, NY (HQ)" says nothing, isRemote is true, workplaceType is Hybrid.
    mockFetch(t);
    const [hybrid, onsite] = await fetchAshby('ramp');
    assert.equal(hybrid.locationType, 'hybrid');
    assert.deepEqual(hybrid.workplace, { type: 'hybrid', source: 'ats' });
    assert.equal(onsite.locationType, 'onsite');
    assert.deepEqual(onsite.workplace, { type: 'onsite', source: 'ats' });
  });

  test('workplaceType is matched case-insensitively', async (t) => {
    mockFetch(t, { body: withJobs({ ...NO_PAY_JOB, workplaceType: 'Remote' }, { ...NO_PAY_JOB, workplaceType: 'remote' }, { ...NO_PAY_JOB, workplaceType: 'ONSITE' }) });
    const jobs = await fetchAshby('ramp');
    assert.deepEqual(jobs.map(j => j.workplace.type), ['remote', 'remote', 'onsite']);
  });

  test('falls back to isRemote when workplaceType is absent; false is no signal', async (t) => {
    const { workplaceType, ...noType } = USD_JOB;
    mockFetch(t, { body: withJobs({ ...noType, isRemote: true }, { ...noType, isRemote: false }) });
    const [remote, unknown] = await fetchAshby('ramp');
    assert.deepEqual(remote.workplace, { type: 'remote', source: 'ats' });
    assert.deepEqual(unknown.workplace, { type: 'unknown', source: null });
    assert.equal(unknown.locationType, 'unknown');
  });

  test('locations carries the primary then every secondaryLocations entry', async (t) => {
    mockFetch(t);
    const [multi, single] = await fetchAshby('ramp');
    assert.equal(multi.location, 'New York, NY (HQ)');
    assert.deepEqual(multi.locations, ['New York, NY (HQ)', 'Remote (US)']);
    assert.deepEqual(single.locations, ['London']);
  });

  test('location_includes matches a secondary location', async (t) => {
    mockFetch(t);
    const jobs = await fetchAshby('ramp');
    assert.deepEqual(applyFilters(jobs, { locationIncludes: ['US'] }).map(j => j.title), [' Security Engineer, Cloud']);
    assert.equal(applyFilters(jobs, { locationExcludes: ['New York'] }).length, 3, 'still open remotely in the US');
    assert.equal(applyFilters(jobs, { locationExcludes: ['New York', 'US'] }).length, 2);
  });

  test('keeps per-tier summaries so OTE and split labels survive', async (t) => {
    mockFetch(t, { body: withJobs({ ...USD_JOB, compensation: TIERED_COMPENSATION }) });
    const [job] = await fetchAshby('ramp');

    assert.deepEqual(job.salary, { min: 131000, max: 191000, currency: 'USD', period: 'year', source: 'ats' });
    assert.equal(job.metadata.compensationSummary, '$131K – $191K • Offers Equity • Offers Commission • Multiple Ranges');
    assert.deepEqual(job.metadata.compensationTiers.map(tier => tier.title), ['NY/SF', 'Nationwide']);
    assert.match(job.metadata.compensationTiers[0].summary, /OTE/);
    assert.equal(job.metadata.compensationTiers[0].additionalInformation, '60/40 split');
  });
});
