import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { orgHost, describeBoard } from '../src/boards.js';

/**
 * org_url is a bare hostname the board links to, and only when that host
 * says something about the company. Every platform's own domain is noise
 * (issues #58, #87).
 */

describe('orgHost', () => {
  test('a company careers link becomes its bare host, lowercased', () => {
    assert.equal(orgHost('https://circle.so/careers'), 'circle.so');
    assert.equal(orgHost('https://Jobs.Tibber.com/jobs/8365823-senior-security-engineer'), 'jobs.tibber.com');
    assert.equal(orgHost('https://www.cisco.com/c/en/us/about/careers.html'), 'www.cisco.com');
  });

  test('every ATS-hosted link yields null', () => {
    for (const link of [
      'https://boards.greenhouse.io/vercel',
      'https://job-boards.greenhouse.io/vercel/jobs/5179639004',
      'https://jobs.lever.co/outreach/5becd4e1',
      'https://jobs.ashbyhq.com/ramp/34413f8d',
      'https://careers.smartrecruiters.com/Wise',
      'https://jobs.smartrecruiters.com/Wise/744000152028489',
      'https://polestar.teamtailor.com/jobs/3528756',
      'https://crunchbase.na.teamtailor.com/jobs/1',
      'https://channable.recruitee.com/o/python-software-engineer',
      'https://cisco.wd5.myworkdayjobs.com/Cisco_Careers/job/x',
    ]) {
      assert.equal(orgHost(link), null, link);
    }
  });

  test('a look-alike on another domain is not an ATS host', () => {
    assert.equal(orgHost('https://greenhouse.io.example.com/jobs'), 'greenhouse.io.example.com');
    assert.equal(orgHost('https://notlever.co/jobs'), 'notlever.co');
  });

  test('a missing or malformed link is null', () => {
    assert.equal(orgHost(''), null);
    assert.equal(orgHost(undefined), null);
    assert.equal(orgHost(null), null);
    assert.equal(orgHost('not a url'), null);
    assert.equal(orgHost('/jobs/123'), null);
  });
});

describe('describeBoard', () => {
  test('carries org_name and org_url through, null when absent', () => {
    const named = describeBoard({ ats: 'recruitee', slug: 'channable', org_name: 'Channable', org_url: 'jobs.channable.com', jobs_found: 1 });
    assert.equal(named.org_name, 'Channable');
    assert.equal(named.org_url, 'jobs.channable.com');
    assert.equal(named.name, null);

    const silent = describeBoard({ ats: 'lever', slug: 'outreach', jobs_found: 1 });
    assert.equal(silent.org_name, null);
    assert.equal(silent.org_url, null);
    assert.equal(silent.scan, null);
  });
});
