import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { registerTools } from '../tools.js';
import { success, error, envelopeSchema } from '../envelope.js';
import { FETCH_JOBS, SEARCH_REGISTRY, DETECT_ATS } from '../descriptions.js';
import { AtsError, ArgumentError, configureHttp, registry } from 'jd-intel';

/**
 * The MCP contract, asserted the way a host sees it: a real McpServer and
 * SDK Client over an in-memory transport, with listTools() called first.
 *
 * The Client compiles its output validators inside listTools(), so a client
 * that has not listed tools runs no client-side validation on callTool.
 * Every test here goes through a listed client, so the server's Zod check,
 * the client's JSON Schema check and the handler logic all run.
 *
 * The library is mocked at the registerTools(server, deps) seam with the
 * full result shapes (fetchJobsDetailed, detectAtsDetailed), except where a
 * test says it runs the real library over a mocked fetch.
 */

async function connectTo(server) {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  await client.listTools();
  return client;
}

async function connect(deps = {}) {
  const server = new McpServer({ name: 'jd-intel-test', version: '0.0.0' });
  registerTools(server, deps);
  return connectTo(server);
}

const call = (client, name, args) => client.callTool({ name, arguments: args });

// The bundled registry with no network, for the tests that run the real library.
async function withBundledRegistry(fn) {
  const prev = process.env.JD_INTEL_REGISTRY_URL;
  process.env.JD_INTEL_REGISTRY_URL = '';
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.JD_INTEL_REGISTRY_URL;
    else process.env.JD_INTEL_REGISTRY_URL = prev;
  }
}

// One attempt per request and no waiting, so a test that answers 429 or 503
// sees exactly one call and runs at full speed.
function noRetries(t) {
  configureHttp({ retries: 1, sleep: async () => {} });
  t.after(() => configureHttp());
}

// Mock fetch by URL substring. Anything unrouted answers 404, the definite
// miss every adapter turns into [] and every has() turns into false.
const okResponse = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => '' });
const statusResponse = (status) => ({ ok: false, status, json: async () => ({}), text: async () => '' });
function mockFetch(t, routes) {
  t.mock.method(global, 'fetch', async (url) => {
    const u = String(url);
    const hit = Object.entries(routes).find(([needle]) => u.includes(needle));
    return hit ? hit[1] : statusResponse(404);
  });
}

// Carries fields JOB does not declare (companySlug, department, ...), so a
// success built from it only validates while JOB stays passthrough.
const boardJob = (i, description = 'desc') => ({
  id: `j${i}`, company: 'Acme', companySlug: 'acme', ats: 'greenhouse', title: `Role ${i}`,
  department: '', location: 'Remote', locationType: 'remote', salary: null,
  description, url: `https://example.com/j/${i}`, postedAt: null,
  firstSeen: 't', lastSeen: 't', status: 'open', metadata: {},
});
const job = { ...boardJob(1), id: 'x1', company: 'Stripe', companySlug: 'stripe', title: 'PM' };

// One boards[] entry, the shape src/boards.js describes.
function board(overrides = {}) {
  return {
    ats: 'greenhouse', slug: 'acme', name: 'Acme', site: null,
    board_url: 'https://boards.greenhouse.io/acme', org_name: null, org_url: null,
    jobs_found: 0, matched: 0, selected: true, scan: null,
    ...overrides,
  };
}

// The full fetchJobsDetailed result. By default a registry hit whose one
// board listed exactly the jobs given; pass match, boards and failed for the
// other paths.
function libraryResult({ jobs = [], match = 'registry', boards, failed = [], total_matched, total_before_filters, company } = {}) {
  const list = boards ?? [board({ name: match === 'registry' ? 'Acme' : null, jobs_found: jobs.length, matched: jobs.length })];
  return {
    jobs,
    total_matched: total_matched ?? jobs.length,
    total_before_filters: total_before_filters ?? list.reduce((n, b) => n + b.jobs_found, 0),
    match,
    company: company !== undefined ? company : match === 'registry' ? { key: 'acme', name: 'Acme' } : null,
    boards: list,
    failed,
  };
}
const returning = (result) => async () => result;
const throwing = (err) => async () => { throw err; };
const failure = (ats, code, message) => ({ ats, slug: 'acme', name: null, code, message });

// A capped Workday board: 500 listed, 100 hydrated.
const cappedBoard = (matched) => board({
  ats: 'workday', slug: 'acme', site: 'careers', board_url: 'https://acme.wd1.myworkdayjobs.com/careers',
  jobs_found: 500, matched, scan: { listed: 500, prefiltered: 500, hydrated: 100, capped: true },
});

async function fetchOk(client, args) {
  const result = await call(client, 'fetch_jobs', args);
  assert.equal(result.isError, undefined, result.content?.[0]?.text);
  assert.ok(['success', 'partial'].includes(result.structuredContent.status), result.structuredContent.status);
  return result;
}

describe('fetch_jobs: arguments reach the library', () => {
  test('workday triple maps to ats:workday + config; metadata says override', async () => {
    let received;
    const client = await connect({
      fetchJobsDetailed: async (opts) => {
        received = opts;
        return libraryResult({
          jobs: [job], match: 'workday_override',
          boards: [board({ ats: 'workday', slug: 'expedia', name: null, site: 'search', board_url: 'https://expedia.wd108.myworkdayjobs.com/search', jobs_found: 1, matched: 1 })],
        });
      },
    });
    const result = await fetchOk(client, { company: 'expedia', workday: { tenant: 'expedia', env: 'wd108', site: 'search' }, limit: 3 });
    assert.equal(received.ats, 'workday');
    assert.deepEqual(received.config, { tenant: 'expedia', env: 'wd108', site: 'search' });
    const { metadata, data } = result.structuredContent;
    assert.equal(data.length, 1);
    assert.equal(metadata.workday_override, true);
    assert.equal(metadata.ats, 'workday');
    assert.equal(metadata.match, 'workday_override');
    assert.equal(metadata.registry_hit, false);
    assert.equal(metadata.company, null);
  });

  test('no workday arg leaves ats and config undefined', async () => {
    let received;
    const client = await connect({ fetchJobsDetailed: async (opts) => { received = opts; return libraryResult(); } });
    const result = await fetchOk(client, { company: 'stripe' });
    assert.equal(received.ats, undefined);
    assert.equal(received.config, undefined);
    assert.equal(result.structuredContent.metadata.workday_override, false);
    assert.equal(result.structuredContent.metadata.ats, 'greenhouse');
  });

  test('order, offset and limit reach the library, defaults filled in', async () => {
    let received;
    const client = await connect({ fetchJobsDetailed: async (opts) => { received = opts; return libraryResult(); } });
    await fetchOk(client, { company: 'stripe' });
    assert.equal(received.order, 'newest');
    assert.equal(received.offset, 0);
    assert.equal(received.limit, 100);
    await fetchOk(client, { company: 'stripe', order: 'board', offset: 20, limit: 10 });
    assert.equal(received.order, 'board');
    assert.equal(received.offset, 20);
    assert.equal(received.limit, 10);
  });

  test('filters reach the library under their library names', async () => {
    let received;
    const client = await connect({ fetchJobsDetailed: async (opts) => { received = opts; return libraryResult(); } });
    await fetchOk(client, { company: 'stripe', title_filter: 'pm', filter: 'api', posted_within_days: 7, location_includes: ['US'], location_excludes: ['Berlin'] });
    assert.equal(received.titleFilter, 'pm');
    assert.equal(received.filter, 'api');
    assert.equal(received.postedWithinDays, 7);
    assert.deepEqual(received.locationIncludes, ['US']);
    assert.deepEqual(received.locationExcludes, ['Berlin']);
  });

  test('max_tokens has no ceiling: a very large value is accepted, and 1 still returns one whole job', async () => {
    const long = [1, 2].map((i) => boardJob(i, 'x'.repeat(5_000)));
    const client = await connect({ fetchJobsDetailed: returning(libraryResult({ jobs: long })) });
    const big = await fetchOk(client, { company: 'acme', max_tokens: 5_000_000 });
    assert.equal(big.structuredContent.metadata.count, 2);
    assert.equal(big.structuredContent.metadata.truncated, null);
    const tiny = await fetchOk(client, { company: 'acme', max_tokens: 1 });
    assert.equal(tiny.structuredContent.metadata.count, 1);
    assert.equal(tiny.structuredContent.data[0].description.length, 5_000);
    assert.deepEqual(tiny.structuredContent.metadata.truncated, { reason: 'size', not_returned: 1 });
  });

  test('offset, order and max_tokens outside their ranges are rejected with text naming the field', async () => {
    const client = await connect({ fetchJobsDetailed: returning(libraryResult({ jobs: [job] })) });
    const bad = [
      [{ company: 'acme', offset: -1 }, /offset/],
      [{ company: 'acme', order: 'oldest' }, /order/],
      [{ company: 'acme', max_tokens: 0 }, /max_tokens/],
      [{ company: 'acme', max_tokens: 1.5 }, /max_tokens/],
      [{ company: 'acme', limit: 0 }, /limit/],
    ];
    for (const [args, pattern] of bad) {
      const result = await call(client, 'fetch_jobs', args);
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.equal(result.structuredContent, undefined, 'a schema failure carries no envelope');
      assert.match(result.content[0].text, pattern);
    }
  });

  test('unknown argument is rejected with text naming it', async () => {
    const client = await connect({ fetchJobsDetailed: returning(libraryResult({ jobs: [job] })) });
    const result = await call(client, 'fetch_jobs', { company: 'stripe', titel_filter: 'PM' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /titel_filter|Unrecognized/i);
  });

  test('a blank or missing workday field is rejected by the schema, naming it, and the library is never called', async () => {
    let called = false;
    const client = await connect({ fetchJobsDetailed: async () => { called = true; return libraryResult(); } });
    const blank = await call(client, 'fetch_jobs', { company: 'x', workday: { tenant: '  ', env: 'wd1', site: 'x' } });
    assert.equal(blank.isError, true);
    assert.match(blank.content[0].text, /tenant/);
    const missing = await call(client, 'fetch_jobs', { company: 'x', workday: { tenant: 'a', env: 'wd1' } });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /site/);
    assert.equal(called, false);
  });
});

describe('fetch_jobs: statuses and codes from the library result (#55, #58, #60)', () => {
  test('registry hit: success carrying match, company, boards, failed [], ats and registry_hit', async () => {
    const client = await connect({ fetchJobsDetailed: returning(libraryResult({ jobs: [job] })) });
    const { structuredContent: env } = await fetchOk(client, { company: 'stripe' });
    assert.equal(env.status, 'success');
    assert.equal(env.metadata.match, 'registry');
    assert.equal(env.metadata.registry_hit, true);
    assert.deepEqual(env.metadata.company, { key: 'acme', name: 'Acme' });
    assert.equal(env.metadata.boards.length, 1);
    assert.equal(env.metadata.boards[0].name, 'Acme');
    assert.deepEqual(env.metadata.failed, []);
    assert.equal(env.metadata.ats, 'greenhouse');
    assert.equal(env.metadata.counts_exact, true);
    assert.equal(env.metadata.total_before_filters, 1);
    assert.match(env.metadata.version, /^\d+\.\d+\.\d+/);
    assert.equal(typeof env.metadata.registry_source, 'string');
  });

  test('registry hit with zero rows is success with data [] and total_before_filters 0', async () => {
    const client = await connect({ fetchJobsDetailed: returning(libraryResult()) });
    const { structuredContent: env } = await fetchOk(client, { company: 'stripe' });
    assert.equal(env.status, 'success');
    assert.deepEqual(env.data, []);
    assert.equal(env.metadata.count, 0);
    assert.equal(env.metadata.total_before_filters, 0);
    assert.equal(env.metadata.registry_hit, true);
  });

  test('#60: a probe board whose rows all miss the filters is success with data [], count 0 and total_before_filters above 0', async () => {
    const client = await connect({
      fetchJobsDetailed: returning(libraryResult({ match: 'probe', boards: [board({ name: null, jobs_found: 3, matched: 0 })] })),
    });
    const { structuredContent: env } = await fetchOk(client, { company: 'nocorp', title_filter: 'product designer' });
    assert.equal(env.status, 'success');
    assert.deepEqual(env.data, []);
    assert.equal(env.metadata.count, 0);
    assert.equal(env.metadata.total_matched, 0);
    assert.equal(env.metadata.total_before_filters, 3);
    assert.equal(env.metadata.match, 'probe');
    assert.equal(env.metadata.registry_hit, false);
    assert.equal(env.metadata.ats, 'greenhouse');
  });

  test('#60 through the real library: an unregistered Greenhouse board with a filter miss is success; every ATS 404 is company_not_found', async (t) => {
    // Discovery on a slug no registry holds: only the Greenhouse mock
    // answers, every other host sees a 404.
    const ghBoard = {
      jobs: ['Account Executive', 'Sales Lead', 'Recruiter'].map((title, i) => ({
        id: i + 1, title, absolute_url: `https://gh.example/${i + 1}`, content: 'Sell.', location: { name: 'Remote' },
      })),
    };
    await withBundledRegistry(async () => {
      mockFetch(t, { 'boards-api.greenhouse.io/v1/boards/zzzfiltermissco/jobs': okResponse(ghBoard) });
      const client = await connect({});
      const miss = await fetchOk(client, { company: 'zzzfiltermissco', title_filter: 'product designer' });
      assert.equal(miss.structuredContent.status, 'success');
      assert.deepEqual(miss.structuredContent.data, []);
      assert.equal(miss.structuredContent.metadata.count, 0);
      assert.equal(miss.structuredContent.metadata.total_before_filters, 3);
      assert.equal(miss.structuredContent.metadata.match, 'probe');
      assert.equal(miss.structuredContent.metadata.ats, 'greenhouse');
      assert.deepEqual(miss.structuredContent.metadata.boards.map((b) => [b.ats, b.slug, b.jobs_found, b.matched]), [['greenhouse', 'zzzfiltermissco', 3, 0]]);

      mockFetch(t, {});
      const gone = await call(client, 'fetch_jobs', { company: 'zzzfiltermissco', title_filter: 'product designer' });
      assert.equal(gone.isError, true);
      assert.equal(gone.structuredContent.error.code, 'company_not_found');
    });
  });

  test('probe with no board and no failure -> company_not_found, isError, client-valid envelope', async () => {
    const client = await connect({ fetchJobsDetailed: returning(libraryResult({ match: 'probe', boards: [] })) });
    const result = await call(client, 'fetch_jobs', { company: 'zzzznotacompany' });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, 'error');
    assert.equal(result.structuredContent.data, null);
    assert.equal(result.structuredContent.error.code, 'company_not_found');
    assert.match(result.structuredContent.error.message, /zzzznotacompany/);
  });

  test('probe with a board and a failed adapter -> partial with metadata.failed and the data that answered', async () => {
    const client = await connect({
      fetchJobsDetailed: returning(libraryResult({ jobs: [job], match: 'probe', failed: [failure('lever', 'rate_limited', 'Lever API error for acme: 429')] })),
    });
    const result = await fetchOk(client, { company: 'acme' });
    const env = result.structuredContent;
    assert.equal(result.isError, undefined, 'partial is a usable answer, not a protocol failure');
    assert.equal(env.status, 'partial');
    assert.equal(env.data.length, 1);
    assert.deepEqual(env.metadata.failed.map((f) => [f.ats, f.code]), [['lever', 'rate_limited']]);
    assert.equal(env.metadata.match, 'probe');
    assert.equal(env.metadata.count, 1);
    assert.equal(typeof env.metadata.est_tokens, 'number');
  });

  test('probe with no board and a 429 among the failures -> rate_limited with metadata.failed', async () => {
    const failed = [failure('greenhouse', 'ats_unreachable', 'Greenhouse API error: 503'), failure('lever', 'rate_limited', 'Lever API error: 429')];
    const client = await connect({ fetchJobsDetailed: returning(libraryResult({ match: 'probe', boards: [], failed })) });
    const result = await call(client, 'fetch_jobs', { company: 'acme' });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'rate_limited');
    assert.deepEqual(result.structuredContent.metadata, { failed });
    assert.match(result.structuredContent.error.message, /lever \(Lever API error: 429\)/);
  });

  test('probe with no board and only non-429 failures -> ats_unreachable with metadata.failed', async () => {
    const failed = [failure('ashby', 'ats_unreachable', 'ashbyhq.com: fetch failed (ECONNRESET)')];
    const client = await connect({ fetchJobsDetailed: returning(libraryResult({ match: 'probe', boards: [], failed })) });
    const result = await call(client, 'fetch_jobs', { company: 'acme' });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'ats_unreachable');
    assert.deepEqual(result.structuredContent.metadata.failed, failed);
  });

  test('workday override returning zero jobs stays success (not company_not_found)', async () => {
    const client = await connect({
      fetchJobsDetailed: returning(libraryResult({ match: 'workday_override', boards: [board({ ats: 'workday', name: null, site: 'c', jobs_found: 0 })] })),
    });
    const { structuredContent: env } = await fetchOk(client, { company: 'x', workday: { tenant: 'a', env: 'b', site: 'c' } });
    assert.equal(env.status, 'success');
    assert.equal(env.metadata.workday_override, true);
    assert.equal(env.metadata.total_before_filters, 0);
  });

  test('real library: a workday override whose site answers 404 is success with total_before_filters 0, not ats_unreachable', async (t) => {
    // Workday answers 404 for a site it does not know. The adapter returns
    // [] and the library keeps an override board whatever it returned, so
    // a wrong site reads as a board with zero rows.
    mockFetch(t, {});
    await withBundledRegistry(async () => {
      const client = await connect({});
      const { structuredContent: env } = await fetchOk(client, { company: 'zzzoverrideco', workday: { tenant: 'zzzoverrideco', env: 'wd1', site: 'nosuchsite' } });
      assert.equal(env.status, 'success');
      assert.deepEqual(env.data, []);
      assert.equal(env.metadata.total_before_filters, 0);
      assert.equal(env.metadata.match, 'workday_override');
      assert.equal(env.metadata.workday_override, true);
      assert.deepEqual(env.metadata.boards.map((b) => [b.ats, b.site, b.jobs_found]), [['workday', 'nosuchsite', 0]]);
    });
  });

  test('ats is the ATS every board shares, null when two boards differ', async () => {
    const two = [board({ name: null, jobs_found: 1, matched: 1 }), board({ ats: 'ashby', name: null, board_url: 'https://jobs.ashbyhq.com/acme', jobs_found: 1, matched: 1 })];
    const client = await connect({ fetchJobsDetailed: returning(libraryResult({ jobs: [job, { ...job, id: 'x2', ats: 'ashby' }], match: 'probe', boards: two })) });
    const { structuredContent: env } = await fetchOk(client, { company: 'acme' });
    assert.equal(env.metadata.ats, null);
    assert.deepEqual(env.metadata.boards.map((b) => b.ats), ['greenhouse', 'ashby']);
  });

  test('AtsError from the library maps by code: rate_limited and ats_unreachable', async () => {
    for (const [code, message] of [['rate_limited', 'Greenhouse API error for stripe: 429'], ['ats_unreachable', 'Lever API error for foo: 500']]) {
      const client = await connect({ fetchJobsDetailed: throwing(new AtsError(code, message)) });
      const result = await call(client, 'fetch_jobs', { company: 'stripe' });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error.code, code);
      assert.equal(result.structuredContent.error.message, message);
      // The library threw for the one board it fetched, so there is no
      // failed list: metadata.failed exists only on a probe outage.
      assert.deepEqual(result.structuredContent.metadata, {});
    }
  });

  test('AtsError with a workday triple keeps the triple-repair hint', async () => {
    const client = await connect({ fetchJobsDetailed: throwing(new AtsError('ats_unreachable', 'Workday API error for x (a/b/c): 422')) });
    const result = await call(client, 'fetch_jobs', { company: 'x', workday: { tenant: 'a', env: 'b', site: 'c' } });
    assert.equal(result.structuredContent.error.code, 'ats_unreachable');
    assert.match(result.structuredContent.error.message, /Workday rejected a\/b\/c: Workday API error/);
    assert.match(result.structuredContent.error.message, /myworkdayjobs\.com/);
  });

  test('ArgumentError -> invalid_args, and so does any error carrying code invalid_args', async () => {
    const typed = await connect({ fetchJobsDetailed: throwing(new ArgumentError('Invalid titleFilter regex: (')) });
    const a = await call(typed, 'fetch_jobs', { company: 'stripe', title_filter: '(' });
    assert.equal(a.isError, true);
    assert.equal(a.structuredContent.error.code, 'invalid_args');
    assert.match(a.structuredContent.error.message, /titleFilter/);

    const coded = await connect({ fetchJobsDetailed: throwing(Object.assign(new Error('company is required'), { code: 'invalid_args' })) });
    const b = await call(coded, 'fetch_jobs', { company: '' });
    assert.equal(b.structuredContent.error.code, 'invalid_args');
  });

  test('a plain Error -> internal_error, not invalid_args', async () => {
    const client = await connect({ fetchJobsDetailed: throwing(new TypeError('some unexpected failure')) });
    const result = await call(client, 'fetch_jobs', { company: 'stripe' });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'internal_error');
    assert.equal(result.structuredContent.error.message, 'some unexpected failure');
  });

  test('real library: a registry company whose ATS is unreachable returns ats_unreachable, not invalid_args', async (t) => {
    // A real registry hit (whichever Greenhouse company is listed first) and
    // a network that fails every request. The adapter wraps the TypeError as
    // AtsError('ats_unreachable'), so the handler maps it by code.
    noRetries(t);
    t.mock.method(global, 'fetch', async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    });
    await withBundledRegistry(async () => {
      const [company] = await registry.load('greenhouse');
      const client = await connect({});
      const result = await call(client, 'fetch_jobs', { company: company.slug });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error.code, 'ats_unreachable');
      assert.match(result.structuredContent.error.message, /greenhouse\.io: fetch failed \(ECONNRESET\)/);
    });
  });

  test('real library: a filter regex that does not compile returns invalid_args before any request', async (t) => {
    let requests = 0;
    t.mock.method(global, 'fetch', async () => { requests += 1; return statusResponse(404); });
    await withBundledRegistry(async () => {
      const client = await connect({});
      const result = await call(client, 'fetch_jobs', { company: 'zzzregexco', title_filter: '(' });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error.code, 'invalid_args');
      assert.equal(requests, 0);
    });
  });
});

describe('fetch_jobs: size, paging and counts (#54, scan cap)', () => {
  // Pages a static, already-sorted set the way the library does, so the
  // handler's cut and paging math is tested against a stable board.
  function pagedLibrary(all, { match = 'registry', boards } = {}) {
    return async ({ offset = 0, limit = 100 }) => libraryResult({
      jobs: all.slice(offset, offset + limit),
      total_matched: all.length,
      match,
      boards: boards ?? [board({ name: match === 'registry' ? 'Acme' : null, jobs_found: all.length, matched: all.length })],
    });
  }

  const BOARD = [1, 2, 3, 4, 5].map((i) => boardJob(i));

  test('every success carries the identity, size and paging metadata', async () => {
    const client = await connect({ fetchJobsDetailed: pagedLibrary(BOARD) });
    const { structuredContent: env } = await fetchOk(client, { company: 'acme' });
    for (const key of [
      'count', 'registry_hit', 'ats', 'workday_override', 'version', 'registry_source',
      'total_matched', 'total_before_filters', 'match', 'company', 'boards', 'failed', 'counts_exact',
      'truncated', 'est_tokens', 'offset', 'next_offset', 'order',
    ]) {
      assert.ok(key in env.metadata, `metadata.${key} missing`);
    }
    assert.equal(env.metadata.count, 5);
    assert.equal(env.metadata.total_matched, 5);
    assert.equal(env.metadata.truncated, null);
    assert.equal(env.metadata.offset, 0);
    assert.equal(env.metadata.next_offset, null);
    assert.equal(env.metadata.order, 'newest');
  });

  test('more matches than limit: total_matched > count, truncated by limit, next_offset set', async () => {
    const client = await connect({ fetchJobsDetailed: pagedLibrary(BOARD) });
    const { structuredContent: env } = await fetchOk(client, { company: 'acme', limit: 2 });
    assert.equal(env.metadata.count, 2);
    assert.equal(env.metadata.total_matched, 5);
    assert.deepEqual(env.metadata.truncated, { reason: 'limit', not_returned: 3 });
    assert.equal(env.metadata.next_offset, 2);
    assert.equal(env.data.length, 2);
  });

  test('est_tokens is chars/4 of the text block actually emitted', async () => {
    const client = await connect({ fetchJobsDetailed: pagedLibrary(BOARD) });
    const result = await fetchOk(client, { company: 'acme', limit: 2 });
    assert.equal(result.structuredContent.metadata.est_tokens, Math.ceil(result.content[0].text.length / 4));
    assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text));
  });

  test('max_tokens adds whole jobs only, cuts by size, never shortens a description', async () => {
    // Three postings of 10,000 characters each: two fit a 6,000-token budget
    // (about 24,000 characters), the third would pass it.
    const long = [1, 2, 3].map((i) => boardJob(i, `${i}`.repeat(10_000)));
    const client = await connect({ fetchJobsDetailed: pagedLibrary(long) });
    const { structuredContent: { data, metadata } } = await fetchOk(client, { company: 'acme', max_tokens: 6000 });
    assert.equal(metadata.count, 2);
    assert.deepEqual(metadata.truncated, { reason: 'size', not_returned: 1 });
    assert.equal(metadata.next_offset, 2);
    assert.ok(metadata.est_tokens <= 6000, `est_tokens ${metadata.est_tokens} over budget`);
    for (const [i, j] of data.entries()) assert.equal(j.description, long[i].description);
  });

  test('a single job past the budget is still returned in full', async () => {
    const huge = [1, 2].map((i) => boardJob(i, 'x'.repeat(20_000)));
    const client = await connect({ fetchJobsDetailed: pagedLibrary(huge) });
    const { structuredContent: { data, metadata } } = await fetchOk(client, { company: 'acme', max_tokens: 2000 });
    assert.equal(metadata.count, 1);
    assert.equal(data[0].description.length, 20_000);
    assert.ok(metadata.est_tokens > 2000);
    assert.deepEqual(metadata.truncated, { reason: 'size', not_returned: 1 });
    assert.equal(metadata.next_offset, 1);
  });

  test('limit wins over size when it stops output first', async () => {
    const long = [1, 2, 3].map((i) => boardJob(i, 'y'.repeat(10_000)));
    const client = await connect({ fetchJobsDetailed: pagedLibrary(long) });
    const { structuredContent: env } = await fetchOk(client, { company: 'acme', limit: 1, max_tokens: 6000 });
    assert.equal(env.metadata.count, 1);
    assert.deepEqual(env.metadata.truncated, { reason: 'limit', not_returned: 2 });
  });

  test('paging with offset = next_offset covers the set with no overlap and no gap', async () => {
    const client = await connect({ fetchJobsDetailed: pagedLibrary(BOARD) });
    const seen = [];
    const totals = new Set();
    let offset = 0;
    let pages = 0;
    while (offset !== null) {
      const { structuredContent: env } = await fetchOk(client, { company: 'acme', limit: 2, offset });
      assert.equal(env.metadata.offset, offset);
      seen.push(...env.data.map((j) => j.id));
      totals.add(env.metadata.total_matched);
      offset = env.metadata.next_offset;
      pages += 1;
    }
    assert.equal(pages, 3);
    assert.deepEqual(seen, ['j1', 'j2', 'j3', 'j4', 'j5']);
    assert.deepEqual([...totals], [5]);
  });

  test('offset past the end of a probed board is an empty success, not company_not_found', async () => {
    const client = await connect({ fetchJobsDetailed: pagedLibrary(BOARD, { match: 'probe' }) });
    const { structuredContent: env } = await fetchOk(client, { company: 'acme', offset: 10 });
    assert.deepEqual(env.data, []);
    assert.equal(env.metadata.count, 0);
    assert.equal(env.metadata.total_matched, 5);
    assert.equal(env.metadata.truncated, null);
    assert.equal(env.metadata.next_offset, null);
  });

  test('a capped scan whose page did not fill: counts_exact false, truncated scan_cap, next_offset null', async () => {
    const client = await connect({ fetchJobsDetailed: pagedLibrary(BOARD, { boards: [cappedBoard(5)] }) });
    const { structuredContent: env } = await fetchOk(client, { company: 'acme' });
    assert.equal(env.metadata.count, 5);
    assert.equal(env.metadata.counts_exact, false);
    assert.deepEqual(env.metadata.truncated, { reason: 'scan_cap', not_returned: null });
    assert.equal(env.metadata.next_offset, null);
    assert.equal(env.metadata.total_before_filters, 500);
    assert.equal(env.metadata.ats, 'workday');
  });

  // A capped adapter (Workday, SmartRecruiters) with no description filter
  // hydrates min(offset + limit, cap) rows of its list and the library pages
  // those, so total_matched is the hydrated count, never the board's.
  function cappedLibrary(all, cap = 100) {
    return async ({ offset = 0, limit = 100 }) => {
      const read = all.slice(0, Math.min(offset + limit, cap));
      return libraryResult({
        jobs: read.slice(offset, offset + limit),
        total_matched: read.length,
        boards: [board({
          ats: 'workday', site: 'careers', board_url: 'https://acme.wd1.myworkdayjobs.com/careers',
          jobs_found: all.length, matched: read.length,
          scan: { listed: all.length, prefiltered: all.length, hydrated: read.length, capped: read.length < all.length },
        })],
      });
    };
  }
  const BIG = Array.from({ length: 120 }, (_, i) => boardJob(i + 1));

  test('a filled page on a capped board pages on: next_offset set beside truncated scan_cap', async () => {
    // total_matched equals offset + count here, so "matches remain" alone
    // would end paging on the first page with 110 rows unread.
    const client = await connect({ fetchJobsDetailed: cappedLibrary(BIG) });
    const { structuredContent: env } = await fetchOk(client, { company: 'acme', limit: 10 });
    assert.equal(env.metadata.count, 10);
    assert.equal(env.metadata.total_matched, 10);
    assert.equal(env.metadata.total_before_filters, 120);
    assert.equal(env.metadata.counts_exact, false);
    assert.deepEqual(env.metadata.truncated, { reason: 'scan_cap', not_returned: null });
    assert.equal(env.metadata.next_offset, 10);
  });

  test('paging a capped board with order board reads up to the cap, then one empty page ends it', async () => {
    const client = await connect({ fetchJobsDetailed: cappedLibrary(BIG) });
    const seen = [];
    let offset = 0;
    let last;
    while (offset !== null) {
      last = (await fetchOk(client, { company: 'acme', limit: 10, offset, order: 'board' })).structuredContent;
      seen.push(...last.data.map((j) => j.id));
      offset = last.metadata.next_offset;
    }
    assert.deepEqual(seen, BIG.slice(0, 100).map((j) => j.id));
    assert.equal(last.metadata.count, 0);
    assert.equal(last.metadata.offset, 100);
    assert.deepEqual(last.metadata.truncated, { reason: 'scan_cap', not_returned: null });
    assert.equal(last.metadata.next_offset, null);
  });

  test('real library: a quick scan of a 120-posting SmartRecruiters board pages on past the first ten (mocked)', async (t) => {
    // Discovery on a slug no registry holds; only the SmartRecruiters mock
    // answers, paging its list by offset and serving a detail per posting.
    const rows = Array.from({ length: 120 }, (_, i) => ({
      id: `sr${i + 1}`, name: `Role ${i + 1}`, releasedDate: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
      location: { city: 'Berlin', country: 'de' }, company: { name: 'Capped Co' },
    }));
    t.mock.method(global, 'fetch', async (url) => {
      const u = new URL(String(url));
      if (u.hostname !== 'api.smartrecruiters.com') return statusResponse(404);
      if (u.pathname === '/v1/companies/zzzcappedco/postings') {
        const offset = Number(u.searchParams.get('offset') || 0);
        const limit = Number(u.searchParams.get('limit') || 100);
        return okResponse({ totalFound: rows.length, content: rows.slice(offset, offset + limit) });
      }
      const detail = u.pathname.match(/^\/v1\/companies\/zzzcappedco\/postings\/(sr\d+)$/);
      if (detail) {
        return okResponse({ postingUrl: `https://jobs.smartrecruiters.com/CappedCo/${detail[1]}`, jobAd: { sections: { jobDescription: { text: 'Ship it.' } } } });
      }
      return statusResponse(404);
    });
    await withBundledRegistry(async () => {
      const client = await connect({});
      const titles = (env) => env.data.map((j) => j.title);
      const first = (await fetchOk(client, { company: 'zzzcappedco', limit: 10, order: 'board' })).structuredContent;
      assert.equal(first.metadata.match, 'probe');
      assert.equal(first.metadata.count, 10);
      assert.equal(first.metadata.total_matched, 10);
      assert.equal(first.metadata.total_before_filters, 120);
      assert.equal(first.metadata.counts_exact, false);
      assert.deepEqual(first.metadata.truncated, { reason: 'scan_cap', not_returned: null });
      assert.equal(first.metadata.next_offset, 10);
      assert.deepEqual(first.metadata.boards.map((b) => [b.ats, b.scan]), [['smartrecruiters', { listed: 120, prefiltered: 120, hydrated: 10, capped: true }]]);

      const second = (await fetchOk(client, { company: 'zzzcappedco', limit: 10, order: 'board', offset: first.metadata.next_offset })).structuredContent;
      assert.deepEqual(titles(second), rows.slice(10, 20).map((r) => r.name));
      assert.equal(second.metadata.next_offset, 20);
      assert.equal(new Set([...titles(first), ...titles(second)]).size, 20, 'the two pages share no row');
    });
  });

  test('a limit cut on a capped scan keeps reason limit, blanks not_returned and still pages', async () => {
    const client = await connect({ fetchJobsDetailed: pagedLibrary(BOARD, { boards: [cappedBoard(5)] }) });
    const { structuredContent: env } = await fetchOk(client, { company: 'acme', limit: 2 });
    assert.equal(env.metadata.counts_exact, false);
    assert.deepEqual(env.metadata.truncated, { reason: 'limit', not_returned: null });
    assert.equal(env.metadata.next_offset, 2);
  });

  test('a size cut on a capped scan keeps reason size and blanks not_returned', async () => {
    const long = [1, 2, 3].map((i) => boardJob(i, 'z'.repeat(10_000)));
    const client = await connect({ fetchJobsDetailed: pagedLibrary(long, { boards: [cappedBoard(3)] }) });
    const { structuredContent: env } = await fetchOk(client, { company: 'acme', max_tokens: 6000 });
    assert.equal(env.metadata.count, 2);
    assert.deepEqual(env.metadata.truncated, { reason: 'size', not_returned: null });
    assert.equal(env.metadata.next_offset, 2);
    assert.ok(env.metadata.est_tokens <= 6000, `est_tokens ${env.metadata.est_tokens} over budget`);
  });

  test('a scan read to the end keeps counts_exact true and truncated null', async () => {
    const full = board({ ats: 'workday', site: 'careers', jobs_found: 5, matched: 5, scan: { listed: 5, prefiltered: 5, hydrated: 5, capped: false } });
    const client = await connect({ fetchJobsDetailed: pagedLibrary(BOARD, { boards: [full] }) });
    const { structuredContent: env } = await fetchOk(client, { company: 'acme' });
    assert.equal(env.metadata.counts_exact, true);
    assert.equal(env.metadata.truncated, null);
  });

  test('order metadata matches data order through the real library (mocked Greenhouse)', async (t) => {
    // Discovery mode on a slug no registry holds: only the Greenhouse mock
    // answers, every other adapter sees a 404. Board order is old, new,
    // undated; newest-first is new, old, undated.
    const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
    const ghBoard = {
      jobs: [
        { id: 1, title: 'Old Role', absolute_url: 'https://gh.example/1', content: 'a', first_published: daysAgo(10), location: { name: 'Remote' } },
        { id: 2, title: 'New Role', absolute_url: 'https://gh.example/2', content: 'b', first_published: daysAgo(2), location: { name: 'Remote' } },
        { id: 3, title: 'Undated Role', absolute_url: 'https://gh.example/3', content: 'c', location: { name: 'Remote' } },
      ],
    };
    mockFetch(t, { 'boards-api.greenhouse.io/v1/boards/zzzorderco/jobs': okResponse(ghBoard) });
    await withBundledRegistry(async () => {
      const client = await connect({});
      const newest = await fetchOk(client, { company: 'zzzorderco' });
      assert.equal(newest.structuredContent.metadata.order, 'newest');
      assert.deepEqual(newest.structuredContent.data.map((j) => j.title), ['New Role', 'Old Role', 'Undated Role']);
      const asBoard = await fetchOk(client, { company: 'zzzorderco', order: 'board' });
      assert.equal(asBoard.structuredContent.metadata.order, 'board');
      assert.deepEqual(asBoard.structuredContent.data.map((j) => j.title), ['Old Role', 'New Role', 'Undated Role']);
      assert.equal(asBoard.structuredContent.metadata.registry_hit, false);
      assert.equal(asBoard.structuredContent.metadata.match, 'probe');
      assert.equal(asBoard.structuredContent.metadata.company, null);
    });
  });

  test('fetch_jobs items carry workplace and locations through the real library and pass both validators (mocked Lever)', async (t) => {
    // Row shape is Lever's: workplaceType at the top level, allLocations in
    // categories. Neither location string carries a keyword, so the native
    // value is the only signal.
    const leverBoard = [
      {
        id: 'l1', text: 'Platform Engineer', hostedUrl: 'https://jobs.lever.co/zzzworkplaceco/l1', createdAt: 1771264785944,
        workplaceType: 'remote',
        categories: { commitment: 'Full-Time', department: 'Engineering', location: 'United States', team: 'Platform', allLocations: ['United States', 'Canada'] },
        description: '<p>Build the platform.</p>', lists: [], additional: '',
      },
      {
        id: 'l2', text: 'Product Designer', hostedUrl: 'https://jobs.lever.co/zzzworkplaceco/l2', createdAt: 1771264785944,
        workplaceType: 'hybrid',
        categories: { commitment: 'Full-Time', department: 'Design', location: 'London', team: 'Design', allLocations: ['London'] },
        description: '<p>Design the product.</p>', lists: [], additional: '',
      },
    ];
    mockFetch(t, { 'api.lever.co/v0/postings/zzzworkplaceco?mode=json': okResponse(leverBoard) });
    await withBundledRegistry(async () => {
      const client = await connect({});
      const rows = async (args) => (await fetchOk(client, { company: 'zzzworkplaceco', ...args })).structuredContent.data;
      const all = await rows({});
      const byTitle = Object.fromEntries(all.map((j) => [j.title, j]));
      assert.deepEqual(byTitle['Platform Engineer'].workplace, { type: 'remote', source: 'ats' });
      assert.equal(byTitle['Platform Engineer'].locationType, 'remote');
      assert.deepEqual(byTitle['Platform Engineer'].locations, ['United States', 'Canada']);
      assert.equal(byTitle['Platform Engineer'].location, 'United States');
      assert.deepEqual(byTitle['Product Designer'].workplace, { type: 'hybrid', source: 'ats' });
      assert.deepEqual(byTitle['Product Designer'].locations, ['London']);
      // includes match a secondary location; excludes drop only when every location matches
      assert.deepEqual((await rows({ location_includes: ['Canada'] })).map((j) => j.title), ['Platform Engineer']);
      assert.deepEqual((await rows({ location_excludes: ['United States'] })).map((j) => j.title).sort(), ['Platform Engineer', 'Product Designer']);
      assert.deepEqual((await rows({ location_excludes: ['United States', 'Canada'] })).map((j) => j.title), ['Product Designer']);
    });
  });
});

describe('envelope: structuredContent, isError and message coercion', () => {
  test('success returns structuredContent matching the text payload, no isError', async () => {
    const client = await connect({ fetchJobsDetailed: returning(libraryResult({ jobs: [job] })) });
    const result = await fetchOk(client, { company: 'stripe' });
    assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text));
    assert.equal(result.isError, undefined);
  });

  test('error() always emits a string message, whatever a handler forwards', () => {
    const schema = envelopeSchema(z.array(z.string()).nullable());
    const cases = [[42, '42'], [undefined, 'Unknown error'], [null, 'Unknown error'], ['', 'Unknown error'], ['boom', 'boom']];
    for (const [input, expected] of cases) {
      const { structuredContent } = error('internal_error', input);
      assert.equal(structuredContent.error.message, expected);
      assert.ok(schema.safeParse(structuredContent).success);
    }
  });

  test('a thrown non-Error with a non-string message still yields a client-valid error envelope on every tool', async () => {
    // Without coercion in error(), error.message would be 42 and the listed
    // client would throw "data/error/message must be string" on every tool.
    const thrower = async () => { throw { message: 42 }; };
    const calls = [
      ['fetch_jobs', { fetchJobsDetailed: thrower }, { company: 'acme' }],
      ['search_registry', { searchRegistry: thrower }, { query: 'acme' }],
      ['detect_ats', { detectAtsDetailed: thrower }, { company: 'acme' }],
    ];
    for (const [name, deps, args] of calls) {
      const client = await connect(deps);
      const result = await call(client, name, args);
      assert.equal(result.isError, true, name);
      assert.equal(result.structuredContent.status, 'error', name);
      assert.equal(result.structuredContent.error.code, 'internal_error', name);
      assert.equal(result.structuredContent.error.message, '42', name);
    }
  });
});

describe('server: tools/list and the envelope extension rule', () => {
  test('tools advertise annotations, an object outputSchema and closed inputs', async () => {
    // This asserts what tools/list advertises, not what the server enforces:
    // a raw shape and a plain z.object also advertise additionalProperties
    // false. The unknown-argument tests prove enforcement.
    const client = await connect({});
    const { tools } = await client.listTools();
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of ['fetch_jobs', 'search_registry', 'detect_ats']) {
      const t = byName[name];
      assert.equal(t.annotations.readOnlyHint, true);
      assert.equal(t.annotations.destructiveHint, false);
      assert.equal(t.annotations.idempotentHint, true);
      assert.equal(t.inputSchema.additionalProperties, false);
      assert.equal(t.outputSchema.type, 'object');
      assert.equal(t.outputSchema.additionalProperties, true);
      assert.equal(t.outputSchema.properties.error.additionalProperties, true);
    }
    assert.equal(byName.fetch_jobs.annotations.openWorldHint, true);
    assert.equal(byName.detect_ats.annotations.openWorldHint, true);
    assert.equal(byName.search_registry.annotations.openWorldHint, false);
    assert.equal(byName.fetch_jobs.inputSchema.properties.max_tokens.maximum, undefined, 'max_tokens has no ceiling');
    assert.equal(byName.fetch_jobs.inputSchema.properties.max_tokens.minimum, 1);
    assert.match(byName.search_registry.inputSchema.properties.query.description, /name or sector/);
  });

  test('envelope top level and error object accept fields the schema does not declare', async () => {
    // Guards the extension rule in envelopeSchema(): a client holding an older
    // tools/list must not throw when a field lands at the top level or on error.
    const server = new McpServer({ name: 'jd-intel-test', version: '0.0.0' });
    server.registerTool(
      'probe',
      {
        inputSchema: z.object({ mode: z.enum(['success', 'error']) }),
        outputSchema: envelopeSchema(z.array(z.string()).nullable()),
      },
      async ({ mode }) => {
        const result = mode === 'success' ? success(['a']) : error('rate_limited', 'slow down');
        if (mode === 'success') result.structuredContent.warnings = [];
        else result.structuredContent.error.retry_after = 30;
        return result;
      }
    );
    const client = await connectTo(server);
    const ok = await call(client, 'probe', { mode: 'success' });
    assert.deepEqual(ok.structuredContent.warnings, []);
    const bad = await call(client, 'probe', { mode: 'error' });
    assert.equal(bad.isError, true);
    assert.equal(bad.structuredContent.error.retry_after, 30);
  });
});

describe('search_registry', () => {
  test('success against the bundled registry passes both validators', async () => {
    await withBundledRegistry(async () => {
      const client = await connect({});
      const result = await call(client, 'search_registry', { sector: 'fintech' });
      assert.equal(result.isError, undefined);
      assert.ok(result.structuredContent.data.length > 0);
    });
  });

  test('success with undeclared entry fields passes both validators', async () => {
    const client = await connect({
      searchRegistry: async () => [{ slug: 'acme', name: 'Acme', sector: 'fintech', ats: 'lever', verified_at: '2026-01-01' }],
    });
    const result = await call(client, 'search_registry', { query: 'acme' });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.status, 'success');
    assert.equal(result.structuredContent.data[0].verified_at, '2026-01-01');
    assert.deepEqual(Object.keys(result.structuredContent.metadata).sort(), ['count', 'query', 'registry_source', 'sector', 'total', 'truncated', 'version']);
  });

  test('caps at the default limit and says how many were left out (issue #62)', async () => {
    const rows = Array.from({ length: 60 }, (_, i) => ({ slug: `co${i}`, name: `Co ${i}`, sector: 'fintech', ats: 'lever' }));
    const client = await connect({ searchRegistry: async () => rows });
    const capped = (await call(client, 'search_registry', { query: 'co' })).structuredContent;
    assert.deepEqual(capped.data.map((r) => r.slug), rows.slice(0, 50).map((r) => r.slug), 'the cut keeps the library\'s order');
    assert.deepEqual([capped.metadata.count, capped.metadata.total], [50, 60]);
    assert.deepEqual(capped.metadata.truncated, { reason: 'limit', not_returned: 10 });
    const all = (await call(client, 'search_registry', { query: 'co', limit: 100 })).structuredContent;
    assert.deepEqual([all.metadata.count, all.metadata.total, all.metadata.truncated], [60, 60, null]);
  });

  test('leaves the Workday config out of the rows', async () => {
    const client = await connect({
      searchRegistry: async () => [{ slug: 'acme', name: 'Acme', sector: 'fintech', ats: 'workday', config: { tenant: 'acme', env: 'wd1', site: 'Careers' } }],
    });
    const result = await call(client, 'search_registry', { query: 'acme' });
    assert.deepEqual(result.structuredContent.data, [{ slug: 'acme', name: 'Acme', sector: 'fintech', ats: 'workday' }]);
  });

  test('query alone matches name or sector; with sector too, both must match (AND)', async () => {
    let term;
    const rows = [
      { slug: 'acme', name: 'Acme', sector: 'fintech', ats: 'lever' },
      { slug: 'acmelabs', name: 'Acme Labs', sector: 'developer tools', ats: 'ashby' },
    ];
    const client = await connect({ searchRegistry: async (q) => { term = q; return rows; } });
    const alone = await call(client, 'search_registry', { query: 'acme' });
    assert.equal(term, 'acme');
    assert.equal(alone.structuredContent.data.length, 2);
    const both = await call(client, 'search_registry', { query: 'acme', sector: 'fintech' });
    assert.equal(term, 'acme', 'query is the search term; sector narrows the hits');
    assert.deepEqual(both.structuredContent.data.map((r) => r.slug), ['acme']);
    assert.deepEqual([both.structuredContent.metadata.query, both.structuredContent.metadata.sector], ['acme', 'fintech']);
  });

  test('error envelope (invalid_args) passes client-side validation', async () => {
    const client = await connect({});
    const result = await call(client, 'search_registry', {});
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, 'error');
    assert.equal(result.structuredContent.data, null);
    assert.equal(result.structuredContent.error.code, 'invalid_args');
  });

  test('unknown argument is rejected with text naming it', async () => {
    const client = await connect({ searchRegistry: async () => [] });
    const result = await call(client, 'search_registry', { query: 'acme', sectr: 'fintech' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /sectr|Unrecognized/i);
  });

  test('a thrown library error comes back as an internal_error envelope', async () => {
    const client = await connect({ searchRegistry: throwing(new TypeError("Cannot read properties of null (reading 'name')")) });
    const result = await call(client, 'search_registry', { query: 'acme' });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'internal_error');
    assert.match(result.structuredContent.error.message, /reading 'name'/);
  });
});

describe('detect_ats: boards, failed and statuses (#55, #87)', () => {
  const known = (ats, source, slug = 'acme') => ({ ats, slug, source });
  const probeFailure = (ats, code, message) => ({ ats, slug: 'acme', code, message });
  const detect = (boards, failed = []) => ({ detectAtsDetailed: returning({ boards, failed }) });
  const PROBEABLE = ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'teamtailor', 'recruitee'];

  test('one registry board: success, data its ats, boards with source, attempted excludes it and Workday', async () => {
    const client = await connect(detect([known('lever', 'registry')]));
    const result = await call(client, 'detect_ats', { company: 'Acme' });
    assert.equal(result.isError, undefined);
    const env = result.structuredContent;
    assert.equal(env.status, 'success');
    assert.equal(env.data, 'lever');
    assert.deepEqual(env.metadata.boards, [{ ats: 'lever', slug: 'acme', source: 'registry' }]);
    assert.deepEqual(env.metadata.succeeded, ['lever']);
    assert.deepEqual(env.metadata.attempted, PROBEABLE.filter((a) => a !== 'lever'));
    assert.deepEqual(env.metadata.failed, []);
    assert.equal('notes' in env.metadata, false);
  });

  test('a registered Workday company is a board from the registry, and attempted lists every probeable ATS', async () => {
    const client = await connect(detect([known('workday', 'registry', 'fixtureco')]));
    const env = (await call(client, 'detect_ats', { company: 'fixtureco' })).structuredContent;
    assert.equal(env.status, 'success');
    assert.equal(env.data, 'workday');
    assert.deepEqual(env.metadata.attempted, PROBEABLE);
  });

  test('one probe board: success with source probe', async () => {
    const client = await connect(detect([known('ashby', 'probe')]));
    const env = (await call(client, 'detect_ats', { company: 'acme' })).structuredContent;
    assert.equal(env.status, 'success');
    assert.equal(env.data, 'ashby');
    assert.deepEqual(env.metadata.boards, [{ ats: 'ashby', slug: 'acme', source: 'probe' }]);
    assert.deepEqual(env.metadata.attempted, PROBEABLE);
  });

  test('no board and no failure: success with data null and every probeable ATS attempted', async () => {
    const client = await connect(detect([]));
    const result = await call(client, 'detect_ats', { company: 'acme' });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.status, 'success');
    assert.equal(result.structuredContent.data, null);
    assert.deepEqual(result.structuredContent.metadata, { attempted: PROBEABLE, succeeded: [], boards: [], failed: [] });
  });

  test('several boards: success (not partial), data is the first in platform order, notes says so', async () => {
    const client = await connect(detect([known('greenhouse', 'registry'), known('ashby', 'probe')]));
    const result = await call(client, 'detect_ats', { company: 'acme' });
    assert.equal(result.isError, undefined);
    const env = result.structuredContent;
    assert.equal(env.status, 'success');
    assert.equal(env.data, 'greenhouse');
    assert.deepEqual(env.metadata.succeeded, ['greenhouse', 'ashby']);
    assert.equal(env.metadata.notes.length, 1);
    assert.match(env.metadata.notes[0], /platform order/);
    assert.match(env.metadata.notes[0], /metadata\.boards/);
    assert.deepEqual(env.metadata.attempted, PROBEABLE.filter((a) => a !== 'greenhouse'));
  });

  test('a board plus a failed probe: partial with metadata.failed, no isError', async () => {
    const failed = [probeFailure('lever', 'rate_limited', 'Lever API error for acme: 429')];
    const client = await connect(detect([known('greenhouse', 'probe')], failed));
    const result = await call(client, 'detect_ats', { company: 'acme' });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.status, 'partial');
    assert.equal(result.structuredContent.data, 'greenhouse');
    assert.deepEqual(result.structuredContent.metadata.failed, failed);
  });

  test('no board and a 429 among the failures: error rate_limited with metadata.failed', async () => {
    const failed = [probeFailure('greenhouse', 'ats_unreachable', 'Greenhouse: 503'), probeFailure('lever', 'rate_limited', 'Lever: 429')];
    const client = await connect(detect([], failed));
    const result = await call(client, 'detect_ats', { company: 'acme' });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, 'error');
    assert.equal(result.structuredContent.data, null);
    assert.equal(result.structuredContent.error.code, 'rate_limited');
    assert.deepEqual(result.structuredContent.metadata, { attempted: PROBEABLE, succeeded: [], boards: [], failed });
    assert.match(result.structuredContent.error.message, /lever \(Lever: 429\)/);
  });

  test('no board and only non-429 failures: error ats_unreachable with metadata.failed', async () => {
    const failed = [probeFailure('ashby', 'ats_unreachable', 'ashbyhq.com: fetch failed (ENOTFOUND)')];
    const client = await connect(detect([], failed));
    const result = await call(client, 'detect_ats', { company: 'acme' });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'ats_unreachable');
    assert.deepEqual(result.structuredContent.metadata.failed, failed);
  });

  test('unknown argument is rejected with text naming it', async () => {
    const client = await connect(detect([]));
    const result = await call(client, 'detect_ats', { company: 'acme', compnay: 'acme' });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /compnay|Unrecognized/i);
  });

  test('a thrown library error comes back as an internal_error envelope', async () => {
    const client = await connect({ detectAtsDetailed: throwing(new Error('probe exploded')) });
    const result = await call(client, 'detect_ats', { company: 'acme' });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'internal_error');
    assert.equal(result.structuredContent.error.message, 'probe exploded');
  });

  test('real library: an unregistered slug with Greenhouse 429 and every other host 404 is rate_limited naming greenhouse', async (t) => {
    noRetries(t);
    mockFetch(t, { 'greenhouse.io': statusResponse(429) });
    await withBundledRegistry(async () => {
      const client = await connect({});
      const result = await call(client, 'detect_ats', { company: 'zzzoutageco' });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error.code, 'rate_limited');
      assert.deepEqual(result.structuredContent.metadata.boards, []);
      assert.deepEqual(result.structuredContent.metadata.failed.map((f) => [f.ats, f.slug, f.code]), [['greenhouse', 'zzzoutageco', 'rate_limited']]);
      assert.deepEqual(result.structuredContent.metadata.attempted, PROBEABLE);

      mockFetch(t, {});
      const none = await call(client, 'detect_ats', { company: 'zzzoutageco' });
      assert.equal(none.isError, undefined);
      assert.equal(none.structuredContent.status, 'success');
      assert.equal(none.structuredContent.data, null);
    });
  });
});

describe('contract: each description names exactly the metadata keys, statuses and codes its handler emits (#56)', () => {
  // The description format the parser relies on: one "RESPONSE:" line whose
  // "metadata: { ... }" braces list the keys, then "STATUSES:" and
  // "ERROR CODES:" lists of "- name: meaning" lines.
  function listed(description, heading) {
    const m = description.match(new RegExp(`^${heading}:\\n((?:- [^\\n]*\\n?)+)`, 'm'));
    assert.ok(m, `${heading} list missing`);
    return [...m[1].matchAll(/^- ([a-z_]+):/gm)].map((x) => x[1]);
  }
  function metadataKeys(description) {
    const m = description.match(/^RESPONSE: .*metadata: \{ ([^}]*) \}/m);
    assert.ok(m, 'RESPONSE line with metadata braces missing');
    return m[1].split(',').map((k) => k.trim()).filter(Boolean);
  }

  // Runs every scenario through a listed client and collects what came back.
  async function emitted(tool, scenarios) {
    const keys = new Set();
    const statuses = new Set();
    const codes = new Set();
    for (const { deps, args } of scenarios) {
      const client = await connect(deps);
      const result = await call(client, tool, args);
      const env = result.structuredContent;
      assert.ok(env, `${tool} ${JSON.stringify(args)}: no envelope (${result.content?.[0]?.text})`);
      statuses.add(env.status);
      for (const k of Object.keys(env.metadata)) keys.add(k);
      if (env.error) codes.add(env.error.code);
    }
    return { keys: [...keys].sort(), statuses: [...statuses].sort(), codes: [...codes].sort() };
  }

  function assertContract(description, actual) {
    assert.deepEqual(actual.keys, metadataKeys(description).sort(), 'metadata keys: named vs emitted');
    assert.deepEqual(actual.statuses, listed(description, 'STATUSES').sort(), 'statuses: named vs emitted');
    assert.deepEqual(actual.codes, listed(description, 'ERROR CODES').sort(), 'error codes: named vs emitted');
  }

  test('fetch_jobs', async () => {
    const limited = failure('lever', 'rate_limited', '429');
    const down = failure('ashby', 'ats_unreachable', '503');
    const scenarios = [
      { deps: { fetchJobsDetailed: returning(libraryResult({ jobs: [job] })) }, args: { company: 'acme' } },
      { deps: { fetchJobsDetailed: returning(libraryResult({ jobs: [job], match: 'probe', failed: [limited] })) }, args: { company: 'acme' } },
      { deps: { fetchJobsDetailed: returning(libraryResult({ match: 'probe', boards: [], failed: [limited, down] })) }, args: { company: 'acme' } },
      { deps: { fetchJobsDetailed: returning(libraryResult({ match: 'probe', boards: [], failed: [down] })) }, args: { company: 'acme' } },
      { deps: { fetchJobsDetailed: returning(libraryResult({ match: 'probe', boards: [] })) }, args: { company: 'acme' } },
      { deps: { fetchJobsDetailed: throwing(new AtsError('ats_unreachable', 'Workday API error: 422')) }, args: { company: 'x', workday: { tenant: 'a', env: 'b', site: 'c' } } },
      { deps: { fetchJobsDetailed: throwing(new ArgumentError('bad regex')) }, args: { company: 'acme' } },
      { deps: { fetchJobsDetailed: throwing(new Error('boom')) }, args: { company: 'acme' } },
    ];
    assertContract(FETCH_JOBS, await emitted('fetch_jobs', scenarios));
  });

  test('search_registry', async () => {
    const scenarios = [
      { deps: { searchRegistry: async () => [{ slug: 'acme', name: 'Acme', sector: 'fintech', ats: 'lever' }] }, args: { query: 'acme', sector: 'fintech' } },
      { deps: {}, args: {} },
      { deps: { searchRegistry: throwing(new Error('boom')) }, args: { query: 'acme' } },
    ];
    assertContract(SEARCH_REGISTRY, await emitted('search_registry', scenarios));
  });

  test('detect_ats', async () => {
    const detect = (boards, failed = []) => ({ detectAtsDetailed: returning({ boards, failed }) });
    const limited = { ats: 'lever', slug: 'acme', code: 'rate_limited', message: '429' };
    const down = { ats: 'ashby', slug: 'acme', code: 'ats_unreachable', message: '503' };
    const scenarios = [
      { deps: detect([{ ats: 'greenhouse', slug: 'acme', source: 'registry' }]), args: { company: 'acme' } },
      { deps: detect([{ ats: 'greenhouse', slug: 'acme', source: 'registry' }, { ats: 'lever', slug: 'acme', source: 'probe' }]), args: { company: 'acme' } },
      { deps: detect([]), args: { company: 'acme' } },
      { deps: detect([{ ats: 'greenhouse', slug: 'acme', source: 'probe' }], [limited]), args: { company: 'acme' } },
      { deps: detect([], [limited]), args: { company: 'acme' } },
      { deps: detect([], [down]), args: { company: 'acme' } },
      { deps: { detectAtsDetailed: throwing(new Error('boom')) }, args: { company: 'acme' } },
    ];
    assertContract(DETECT_ATS, await emitted('detect_ats', scenarios));
  });

  test('the parser reads the real descriptions: every list is non-empty and every tool has a RESPONSE line', () => {
    for (const [name, description] of [['fetch_jobs', FETCH_JOBS], ['search_registry', SEARCH_REGISTRY], ['detect_ats', DETECT_ATS]]) {
      assert.ok(metadataKeys(description).length > 0, `${name}: metadata keys`);
      assert.ok(listed(description, 'STATUSES').includes('success'), `${name}: statuses`);
      assert.ok(listed(description, 'ERROR CODES').includes('internal_error'), `${name}: error codes`);
    }
  });
});

describe('voice: the AI-facing strings carry no em dashes', () => {
  test('descriptions.js exports', () => {
    for (const [name, text] of [['FETCH_JOBS', FETCH_JOBS], ['SEARCH_REGISTRY', SEARCH_REGISTRY], ['DETECT_ATS', DETECT_ATS]]) {
      assert.equal(text.includes('—'), false, `${name} contains an em dash`);
    }
  });

  test('argument describe strings advertised in tools/list', async () => {
    const client = await connect({});
    const { tools } = await client.listTools();
    for (const tool of tools) {
      for (const [field, schema] of Object.entries(tool.inputSchema.properties)) {
        assert.equal((schema.description || '').includes('—'), false, `${tool.name}.${field} describe contains an em dash`);
      }
    }
  });
});
