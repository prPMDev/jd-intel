import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { registerTools } from '../tools.js';
import { success, error, envelopeSchema } from '../envelope.js';
import { AtsError } from 'jd-intel';

/**
 * First automated MCP test. Uses the registerTools(server, deps) seam to
 * inject a mock library, so this is offline and asserts the AI-facing
 * contract: how the `workday` arg maps to the library `fetchJobsDetailed`
 * call, the envelope metadata, and the error-code taxonomy.
 */

function getFetchJobsHandler(deps) {
  const handlers = {};
  const fakeServer = { registerTool: (name, _def, handler) => { handlers[name] = handler; } };
  registerTools(fakeServer, deps);
  return handlers.fetch_jobs;
}

const parse = (result) => JSON.parse(result.content[0].text);

describe('mcp fetch_jobs — workday passthrough', () => {
  test('workday triple maps to ats:workday + config and sets metadata', async () => {
    let received;
    const handler = getFetchJobsHandler({
      fetchJobsDetailed: async (opts) => { received = opts; return { jobs: [{ title: 'PM' }], total_matched: 1 }; },
      findAtsBySlug: async () => null,
    });
    const result = await handler({
      company: 'expedia',
      workday: { tenant: 'expedia', env: 'wd108', site: 'search' },
      limit: 3,
    });
    assert.equal(received.ats, 'workday');
    assert.deepEqual(received.config, { tenant: 'expedia', env: 'wd108', site: 'search' });
    const env = parse(result);
    assert.equal(env.status, 'success');
    assert.equal(env.data.length, 1);
    assert.equal(env.metadata.workday_override, true);
    assert.equal(env.metadata.ats, 'workday');
  });

  test('no workday arg leaves ats and config undefined', async () => {
    let received;
    const handler = getFetchJobsHandler({
      fetchJobsDetailed: async (opts) => { received = opts; return { jobs: [], total_matched: 0 }; },
      findAtsBySlug: async () => 'greenhouse',
    });
    const result = await handler({ company: 'stripe' });
    assert.equal(received.ats, undefined);
    assert.equal(received.config, undefined);
    const env = parse(result);
    assert.equal(env.status, 'success');
    assert.equal(env.metadata.workday_override, false);
    assert.equal(env.metadata.ats, 'greenhouse');
  });

  test('order, offset and limit reach the library, defaults filled in', async () => {
    let received;
    const handler = getFetchJobsHandler({
      fetchJobsDetailed: async (opts) => { received = opts; return { jobs: [], total_matched: 0 }; },
      findAtsBySlug: async () => 'greenhouse',
    });
    await handler({ company: 'stripe' });
    assert.equal(received.order, 'newest');
    assert.equal(received.offset, 0);
    assert.equal(received.limit, 100);
    await handler({ company: 'stripe', order: 'board', offset: 20, limit: 10 });
    assert.equal(received.order, 'board');
    assert.equal(received.offset, 20);
    assert.equal(received.limit, 10);
  });

  test('incomplete (whitespace) workday triple -> invalid_args, fetchJobs not called', async () => {
    let called = false;
    const handler = getFetchJobsHandler({
      fetchJobsDetailed: async () => { called = true; return { jobs: [], total_matched: 0 }; },
      findAtsBySlug: async () => null,
    });
    const result = await handler({ company: 'x', workday: { tenant: '  ', env: 'wd1', site: 'x' } });
    assert.equal(called, false);
    const env = parse(result);
    assert.equal(env.status, 'error');
    assert.equal(env.error.code, 'invalid_args');
  });

  test('library Workday API error with a triple -> ats_unreachable', async () => {
    const handler = getFetchJobsHandler({
      fetchJobsDetailed: async () => { throw new AtsError('ats_unreachable', 'Workday API error for x (a/b/c): 422'); },
      findAtsBySlug: async () => null,
    });
    const result = await handler({ company: 'x', workday: { tenant: 'a', env: 'b', site: 'c' } });
    const env = parse(result);
    assert.equal(env.status, 'error');
    assert.equal(env.error.code, 'ats_unreachable');
  });

  test('generic library error without workday still maps to invalid_args', async () => {
    const handler = getFetchJobsHandler({
      fetchJobsDetailed: async () => { throw new Error('Company slug required'); },
      findAtsBySlug: async () => null,
    });
    const result = await handler({ company: '' });
    const env = parse(result);
    assert.equal(env.status, 'error');
    assert.equal(env.error.code, 'invalid_args');
  });

  test('success metadata carries the server version and registry source', async () => {
    const handler = getFetchJobsHandler({
      fetchJobsDetailed: async () => ({ jobs: [{ title: 'PM' }], total_matched: 1 }),
      findAtsBySlug: async () => 'greenhouse',
    });
    const env = parse(await handler({ company: 'stripe' }));
    assert.equal(env.status, 'success');
    assert.match(env.metadata.version, /^\d+\.\d+\.\d+/);
    assert.equal(typeof env.metadata.registry_source, 'string');
  });

  test('rate-limited adapter error -> rate_limited', async () => {
    const handler = getFetchJobsHandler({
      fetchJobsDetailed: async () => { throw new AtsError('rate_limited', 'Greenhouse API error for stripe: 429'); },
      findAtsBySlug: async () => 'greenhouse',
    });
    const env = parse(await handler({ company: 'stripe' }));
    assert.equal(env.status, 'error');
    assert.equal(env.error.code, 'rate_limited');
  });

  test('non-429 adapter API error -> ats_unreachable', async () => {
    const handler = getFetchJobsHandler({
      fetchJobsDetailed: async () => { throw new AtsError('ats_unreachable', 'Lever API error for foo: 500'); },
      findAtsBySlug: async () => 'lever',
    });
    const env = parse(await handler({ company: 'foo' }));
    assert.equal(env.status, 'error');
    assert.equal(env.error.code, 'ats_unreachable');
  });

  test('a non-AtsError (plain Error) maps to invalid_args', async () => {
    const handler = getFetchJobsHandler({
      fetchJobsDetailed: async () => { throw new Error('some unexpected failure'); },
      findAtsBySlug: async () => 'greenhouse',
    });
    const env = parse(await handler({ company: 'stripe' }));
    assert.equal(env.error.code, 'invalid_args');
  });

  test('discovery miss (no registry hit, no jobs) -> company_not_found', async () => {
    const handler = getFetchJobsHandler({
      fetchJobsDetailed: async () => ({ jobs: [], total_matched: 0 }),
      findAtsBySlug: async () => null,
    });
    const env = parse(await handler({ company: 'zzzznotacompany' }));
    assert.equal(env.status, 'error');
    assert.equal(env.error.code, 'company_not_found');
  });

  test('registry hit with zero open roles stays success([])', async () => {
    const handler = getFetchJobsHandler({
      fetchJobsDetailed: async () => ({ jobs: [], total_matched: 0 }),
      findAtsBySlug: async () => 'greenhouse',
    });
    const env = parse(await handler({ company: 'stripe' }));
    assert.equal(env.status, 'success');
    assert.equal(env.data.length, 0);
    assert.equal(env.metadata.registry_hit, true);
  });

  test('workday override returning zero jobs stays success (not company_not_found)', async () => {
    const handler = getFetchJobsHandler({
      fetchJobsDetailed: async () => ({ jobs: [], total_matched: 0 }),
      findAtsBySlug: async () => null,
    });
    const env = parse(await handler({
      company: 'x',
      workday: { tenant: 'a', env: 'b', site: 'c' },
    }));
    assert.equal(env.status, 'success');
    assert.equal(env.metadata.workday_override, true);
  });
});

describe('mcp envelope — structuredContent and isError', () => {
  test('success returns structuredContent matching the text payload, no isError', async () => {
    const handler = getFetchJobsHandler({
      fetchJobsDetailed: async () => ({ jobs: [{ title: 'PM' }], total_matched: 1 }),
      findAtsBySlug: async () => 'greenhouse',
    });
    const result = await handler({ company: 'stripe' });
    assert.deepEqual(result.structuredContent, parse(result));
    assert.equal(result.isError, undefined);
  });

  test('error sets isError and keeps the structured error code', async () => {
    const handler = getFetchJobsHandler({
      fetchJobsDetailed: async () => ({ jobs: [], total_matched: 0 }),
      findAtsBySlug: async () => null,
    });
    const result = await handler({ company: 'zzzznotacompany' });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, 'company_not_found');
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
});

describe('mcp server — end to end over an in-memory transport', async () => {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

  // The Client compiles its output validators inside listTools(), so a client
  // that has not listed tools runs no client-side validation on callTool.
  // Every test here goes through a listed client so both validators run.
  async function connectTo(server) {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    await client.listTools();
    return client;
  }

  async function connect(deps) {
    const server = new McpServer({ name: 'jd-intel-test', version: '0.0.0' });
    registerTools(server, deps);
    return connectTo(server);
  }

  // Carries fields JOB does not declare (companySlug, department, ...), so a
  // success built from it only validates while JOB stays passthrough.
  const job = {
    id: 'x1', company: 'Stripe', companySlug: 'stripe', ats: 'greenhouse', title: 'PM',
    department: '', location: 'Remote', locationType: 'remote', salary: null,
    description: 'desc', url: 'https://example.com/j/1', postedAt: null,
    firstSeen: 't', lastSeen: 't', status: 'open', metadata: {},
  };

  test('tools advertise annotations, an object outputSchema and closed inputs', async () => {
    // This asserts what tools/list advertises, not what the server enforces:
    // a raw shape and a plain z.object also advertise additionalProperties
    // false. The unknown-argument tests below prove enforcement.
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
    const ok = await client.callTool({ name: 'probe', arguments: { mode: 'success' } });
    assert.deepEqual(ok.structuredContent.warnings, []);
    const bad = await client.callTool({ name: 'probe', arguments: { mode: 'error' } });
    assert.equal(bad.isError, true);
    assert.equal(bad.structuredContent.error.retry_after, 30);
  });

  test('fetch_jobs success with undeclared job fields passes both validators', async () => {
    const client = await connect({
      fetchJobsDetailed: async () => ({ jobs: [job], total_matched: 1 }),
      findAtsBySlug: async () => 'greenhouse',
    });
    const result = await client.callTool({ name: 'fetch_jobs', arguments: { company: 'stripe' } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.status, 'success');
    assert.equal(result.structuredContent.data[0].title, 'PM');
    assert.equal(result.structuredContent.data[0].companySlug, 'stripe');
  });

  test('fetch_jobs items carry workplace and locations through the real library and pass both validators (mocked Lever)', async (t) => {
    // Discovery mode on a slug no registry holds: only the Lever mock answers.
    // Row shape is Lever's: workplaceType at the top level, allLocations in
    // categories. Neither location string carries a keyword, so the native
    // value is the only signal.
    const board = [
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
    t.mock.method(global, 'fetch', async (url) => {
      if (String(url) === 'https://api.lever.co/v0/postings/zzzworkplaceco?mode=json') {
        return { ok: true, status: 200, json: async () => board };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    });
    const prev = process.env.JD_INTEL_REGISTRY_URL;
    process.env.JD_INTEL_REGISTRY_URL = ''; // bundled registry, no network
    try {
      const client = await connect({});
      const call = async (args) => {
        const result = await client.callTool({ name: 'fetch_jobs', arguments: { company: 'zzzworkplaceco', ...args } });
        assert.equal(result.isError, undefined, result.content?.[0]?.text);
        assert.equal(result.structuredContent.status, 'success');
        return result.structuredContent.data;
      };

      const all = await call({});
      const byTitle = Object.fromEntries(all.map((j) => [j.title, j]));
      assert.deepEqual(byTitle['Platform Engineer'].workplace, { type: 'remote', source: 'ats' });
      assert.equal(byTitle['Platform Engineer'].locationType, 'remote');
      assert.deepEqual(byTitle['Platform Engineer'].locations, ['United States', 'Canada']);
      assert.equal(byTitle['Platform Engineer'].location, 'United States');
      assert.deepEqual(byTitle['Product Designer'].workplace, { type: 'hybrid', source: 'ats' });
      assert.deepEqual(byTitle['Product Designer'].locations, ['London']);

      // includes match a secondary location; excludes drop only when every location matches
      assert.deepEqual((await call({ location_includes: ['Canada'] })).map((j) => j.title), ['Platform Engineer']);
      assert.deepEqual((await call({ location_excludes: ['United States'] })).map((j) => j.title).sort(), ['Platform Engineer', 'Product Designer']);
      assert.deepEqual((await call({ location_excludes: ['United States', 'Canada'] })).map((j) => j.title), ['Product Designer']);
    } finally {
      if (prev === undefined) delete process.env.JD_INTEL_REGISTRY_URL;
      else process.env.JD_INTEL_REGISTRY_URL = prev;
    }
  });

  test('fetch_jobs on a registry company whose ATS is unreachable returns ats_unreachable, not invalid_args', async (t) => {
    // The real library, a real registry hit (whichever Greenhouse company is
    // listed first), and a network that fails every request. The adapter's
    // atsFetch wraps the TypeError as AtsError('ats_unreachable'), so the
    // handler maps it by code instead of falling through to invalid_args.
    const { configureHttp, registry } = await import('jd-intel');
    configureHttp({ retries: 1, sleep: async () => {} });
    t.after(() => configureHttp());
    t.mock.method(global, 'fetch', async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } });
    });
    const prev = process.env.JD_INTEL_REGISTRY_URL;
    process.env.JD_INTEL_REGISTRY_URL = ''; // bundled registry, no network
    try {
      const [company] = await registry.load('greenhouse');
      const client = await connect({});
      const result = await client.callTool({ name: 'fetch_jobs', arguments: { company: company.slug } });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.status, 'error');
      assert.equal(result.structuredContent.error.code, 'ats_unreachable');
      assert.match(result.structuredContent.error.message, /greenhouse\.io: fetch failed \(ECONNRESET\)/);
    } finally {
      if (prev === undefined) delete process.env.JD_INTEL_REGISTRY_URL;
      else process.env.JD_INTEL_REGISTRY_URL = prev;
    }
  });

  test('fetch_jobs error envelope passes client-side validation and sets isError', async () => {
    const client = await connect({ fetchJobsDetailed: async () => ({ jobs: [], total_matched: 0 }), findAtsBySlug: async () => null });
    const result = await client.callTool({ name: 'fetch_jobs', arguments: { company: 'zzzz' } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, 'error');
    assert.equal(result.structuredContent.data, null);
    assert.equal(result.structuredContent.error.code, 'company_not_found');
  });

  test('fetch_jobs unknown argument is rejected with text naming it', async () => {
    const client = await connect({ fetchJobsDetailed: async () => ({ jobs: [job], total_matched: 1 }), findAtsBySlug: async () => 'greenhouse' });
    const result = await client.callTool({ name: 'fetch_jobs', arguments: { company: 'stripe', titel_filter: 'PM' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /titel_filter|Unrecognized/i);
  });

  test('search_registry success against the bundled registry passes both validators', async () => {
    const prev = process.env.JD_INTEL_REGISTRY_URL;
    process.env.JD_INTEL_REGISTRY_URL = ''; // bundled registry, no network
    try {
      const client = await connect({});
      const result = await client.callTool({ name: 'search_registry', arguments: { sector: 'fintech' } });
      assert.equal(result.isError, undefined);
      assert.ok(result.structuredContent.data.length > 0);
    } finally {
      if (prev === undefined) delete process.env.JD_INTEL_REGISTRY_URL;
      else process.env.JD_INTEL_REGISTRY_URL = prev;
    }
  });

  test('search_registry success with undeclared entry fields passes both validators', async () => {
    const client = await connect({
      searchRegistry: async () => [{ slug: 'acme', name: 'Acme', sector: 'fintech', ats: 'lever', verified_at: '2026-01-01' }],
    });
    const result = await client.callTool({ name: 'search_registry', arguments: { query: 'acme' } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.status, 'success');
    assert.equal(result.structuredContent.data[0].verified_at, '2026-01-01');
  });

  test('search_registry error envelope (invalid_args) passes client-side validation', async () => {
    const client = await connect({});
    const result = await client.callTool({ name: 'search_registry', arguments: {} });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, 'error');
    assert.equal(result.structuredContent.data, null);
    assert.equal(result.structuredContent.error.code, 'invalid_args');
  });

  test('search_registry unknown argument is rejected with text naming it', async () => {
    const client = await connect({ searchRegistry: async () => [] });
    const result = await client.callTool({ name: 'search_registry', arguments: { query: 'acme', sectr: 'fintech' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /sectr|Unrecognized/i);
  });

  test('search_registry: a thrown library error comes back as an internal_error envelope', async () => {
    const client = await connect({
      searchRegistry: async () => { throw new TypeError("Cannot read properties of null (reading 'name')"); },
    });
    const result = await client.callTool({ name: 'search_registry', arguments: { query: 'acme' } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, 'error');
    assert.equal(result.structuredContent.error.code, 'internal_error');
    assert.match(result.structuredContent.error.message, /reading 'name'/);
  });

  test('detect_ats single match returns success and passes both validators', async () => {
    const client = await connect({ detectAts: async () => [{ ats: 'lever', slug: 'acme' }] });
    const result = await client.callTool({ name: 'detect_ats', arguments: { company: 'Acme' } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.status, 'success');
    assert.equal(result.structuredContent.data, 'lever');
  });

  test('detect_ats no match returns success with data null and passes both validators', async () => {
    const client = await connect({ detectAts: async () => [] });
    const result = await client.callTool({ name: 'detect_ats', arguments: { company: 'acme' } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.status, 'success');
    assert.equal(result.structuredContent.data, null);
  });

  test('detect_ats multi-match returns partial with notes in metadata and passes both validators', async () => {
    // data is a scalar here, so the undeclared-field case lives in metadata.
    const client = await connect({
      detectAts: async () => [{ ats: 'lever', slug: 'acme' }, { ats: 'ashby', slug: 'acme' }],
    });
    const result = await client.callTool({ name: 'detect_ats', arguments: { company: 'acme' } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.status, 'partial');
    assert.deepEqual(result.structuredContent.metadata.succeeded, ['lever', 'ashby']);
    assert.equal(result.structuredContent.metadata.notes.length, 1);
  });

  test('detect_ats unknown argument is rejected with text naming it', async () => {
    const client = await connect({ detectAts: async () => [] });
    const result = await client.callTool({ name: 'detect_ats', arguments: { company: 'acme', compnay: 'acme' } });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /compnay|Unrecognized/i);
  });

  test('detect_ats: a thrown library error comes back as an internal_error envelope', async () => {
    const client = await connect({ detectAts: async () => { throw new Error('probe exploded'); } });
    const result = await client.callTool({ name: 'detect_ats', arguments: { company: 'acme' } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, 'error');
    assert.equal(result.structuredContent.data, null);
    assert.equal(result.structuredContent.error.code, 'internal_error');
    assert.equal(result.structuredContent.error.message, 'probe exploded');
  });

  test('a thrown non-Error with a non-string message still yields a client-valid error envelope', async () => {
    // Without coercion in error(), error.message would be 42 and the listed
    // client would throw "data/error/message must be string" on every tool.
    const thrower = async () => { throw { message: 42 }; };
    const calls = [
      ['fetch_jobs', { fetchJobsDetailed: thrower, findAtsBySlug: async () => null }, { company: 'acme' }],
      ['search_registry', { searchRegistry: thrower }, { query: 'acme' }],
      ['detect_ats', { detectAts: thrower }, { company: 'acme' }],
    ];
    for (const [name, deps, args] of calls) {
      const client = await connect(deps);
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true, name);
      assert.equal(result.structuredContent.status, 'error', name);
      assert.equal(result.structuredContent.error.message, '42', name);
    }
  });
});

describe('mcp fetch_jobs — size reporting, budget and paging (#54)', async () => {
  const { McpServer } = await import('@modelcontextprotocol/sdk/server/mcp.js');
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { InMemoryTransport } = await import('@modelcontextprotocol/sdk/inMemory.js');

  async function connect(deps) {
    const server = new McpServer({ name: 'jd-intel-test', version: '0.0.0' });
    registerTools(server, deps);
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test-client', version: '0.0.0' });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    await client.listTools();
    return client;
  }

  const boardJob = (i, description = 'desc') => ({
    id: `j${i}`, company: 'Acme', companySlug: 'acme', ats: 'greenhouse', title: `Role ${i}`,
    department: '', location: 'Remote', locationType: 'remote', salary: null,
    description, url: `https://example.com/j/${i}`, postedAt: null,
    firstSeen: 't', lastSeen: 't', status: 'open', metadata: {},
  });

  // Pages a static, already-sorted set the way applyFiltersDetailed does, so
  // the handler's cut and paging math is tested against a stable board.
  function pagedLibrary(all) {
    return async ({ offset = 0, limit = 100 }) => ({
      jobs: all.slice(offset, offset + limit),
      total_matched: all.length,
    });
  }

  const SIZE_KEYS = ['total_matched', 'truncated', 'est_tokens', 'offset', 'next_offset', 'order'];
  const BOARD = [1, 2, 3, 4, 5].map((i) => boardJob(i));

  async function fetchJobs(client, args) {
    const result = await client.callTool({ name: 'fetch_jobs', arguments: args });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    assert.equal(result.structuredContent.status, 'success');
    return result;
  }

  test('every success carries the size and paging metadata next to the existing keys', async () => {
    const client = await connect({ fetchJobsDetailed: pagedLibrary(BOARD), findAtsBySlug: async () => 'greenhouse' });
    const { structuredContent: env } = await fetchJobs(client, { company: 'acme' });
    for (const key of ['count', 'registry_hit', 'ats', 'workday_override', 'version', 'registry_source', ...SIZE_KEYS]) {
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
    const client = await connect({ fetchJobsDetailed: pagedLibrary(BOARD), findAtsBySlug: async () => 'greenhouse' });
    const result = await fetchJobs(client, { company: 'acme', limit: 2 });
    const { metadata } = result.structuredContent;
    assert.equal(metadata.count, 2);
    assert.equal(metadata.total_matched, 5);
    assert.ok(metadata.total_matched > metadata.count);
    assert.deepEqual(metadata.truncated, { reason: 'limit', not_returned: 3 });
    assert.equal(metadata.next_offset, 2);
    assert.equal(result.structuredContent.data.length, 2);
  });

  test('est_tokens is chars/4 of the text block actually emitted', async () => {
    const client = await connect({ fetchJobsDetailed: pagedLibrary(BOARD), findAtsBySlug: async () => 'greenhouse' });
    const result = await fetchJobs(client, { company: 'acme', limit: 2 });
    assert.equal(result.structuredContent.metadata.est_tokens, Math.ceil(result.content[0].text.length / 4));
    assert.deepEqual(result.structuredContent, JSON.parse(result.content[0].text));
  });

  test('max_tokens adds whole jobs only, cuts by size, never shortens a description', async () => {
    // Three postings of 10,000 characters each: two fit a 6,000-token budget
    // (about 24,000 characters), the third would pass it.
    const long = [1, 2, 3].map((i) => boardJob(i, `${i}`.repeat(10_000)));
    const client = await connect({ fetchJobsDetailed: pagedLibrary(long), findAtsBySlug: async () => 'greenhouse' });
    const result = await fetchJobs(client, { company: 'acme', max_tokens: 6000 });
    const { data, metadata } = result.structuredContent;
    assert.equal(metadata.count, 2);
    assert.equal(data.length, 2);
    assert.deepEqual(metadata.truncated, { reason: 'size', not_returned: 1 });
    assert.equal(metadata.next_offset, 2);
    assert.ok(metadata.est_tokens <= 6000, `est_tokens ${metadata.est_tokens} over budget`);
    for (const [i, job] of data.entries()) {
      assert.equal(job.description.length, long[i].description.length);
      assert.equal(job.description, long[i].description);
    }
  });

  test('a single job past the budget is still returned in full', async () => {
    const huge = [1, 2].map((i) => boardJob(i, 'x'.repeat(20_000)));
    const client = await connect({ fetchJobsDetailed: pagedLibrary(huge), findAtsBySlug: async () => 'greenhouse' });
    const result = await fetchJobs(client, { company: 'acme', max_tokens: 2000 });
    const { data, metadata } = result.structuredContent;
    assert.equal(metadata.count, 1);
    assert.equal(data[0].description.length, 20_000);
    assert.ok(metadata.est_tokens > 2000);
    assert.deepEqual(metadata.truncated, { reason: 'size', not_returned: 1 });
    assert.equal(metadata.next_offset, 1);
  });

  test('limit wins over size when it stops output first', async () => {
    const long = [1, 2, 3].map((i) => boardJob(i, 'y'.repeat(10_000)));
    const client = await connect({ fetchJobsDetailed: pagedLibrary(long), findAtsBySlug: async () => 'greenhouse' });
    const { structuredContent: env } = await fetchJobs(client, { company: 'acme', limit: 1, max_tokens: 6000 });
    assert.equal(env.metadata.count, 1);
    assert.deepEqual(env.metadata.truncated, { reason: 'limit', not_returned: 2 });
  });

  test('paging with offset = next_offset covers the set with no overlap and no gap', async () => {
    const client = await connect({ fetchJobsDetailed: pagedLibrary(BOARD), findAtsBySlug: async () => 'greenhouse' });
    const seen = [];
    const totals = new Set();
    let offset = 0;
    let pages = 0;
    while (offset !== null) {
      const { structuredContent: env } = await fetchJobs(client, { company: 'acme', limit: 2, offset });
      assert.equal(env.metadata.offset, offset);
      seen.push(...env.data.map((j) => j.id));
      totals.add(env.metadata.total_matched);
      offset = env.metadata.next_offset;
      pages += 1;
    }
    assert.equal(pages, 3);
    assert.deepEqual(seen, ['j1', 'j2', 'j3', 'j4', 'j5']);
    assert.equal(new Set(seen).size, seen.length);
    assert.deepEqual([...totals], [5]);
  });

  test('offset past the end is an empty success, not company_not_found', async () => {
    const client = await connect({ fetchJobsDetailed: pagedLibrary(BOARD), findAtsBySlug: async () => null });
    const { structuredContent: env } = await fetchJobs(client, { company: 'acme', offset: 10 });
    assert.deepEqual(env.data, []);
    assert.equal(env.metadata.count, 0);
    assert.equal(env.metadata.total_matched, 5);
    assert.equal(env.metadata.truncated, null);
    assert.equal(env.metadata.next_offset, null);
  });

  test('order metadata matches data order through the real library (mocked Greenhouse)', async (t) => {
    // Discovery mode on a slug no registry holds: only the Greenhouse mock
    // answers, every other adapter sees a 404. Board order is old, new,
    // undated; newest-first is new, old, undated.
    const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString();
    const board = {
      jobs: [
        { id: 1, title: 'Old Role', absolute_url: 'https://gh.example/1', content: 'a', first_published: daysAgo(10), location: { name: 'Remote' } },
        { id: 2, title: 'New Role', absolute_url: 'https://gh.example/2', content: 'b', first_published: daysAgo(2), location: { name: 'Remote' } },
        { id: 3, title: 'Undated Role', absolute_url: 'https://gh.example/3', content: 'c', location: { name: 'Remote' } },
      ],
    };
    t.mock.method(global, 'fetch', async (url) => {
      if (String(url) === 'https://boards-api.greenhouse.io/v1/boards/zzzorderco/jobs?content=true') {
        return { ok: true, status: 200, json: async () => board };
      }
      return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
    });
    const prev = process.env.JD_INTEL_REGISTRY_URL;
    process.env.JD_INTEL_REGISTRY_URL = ''; // bundled registry, no network
    try {
      const client = await connect({});
      const newest = await fetchJobs(client, { company: 'zzzorderco' });
      assert.equal(newest.structuredContent.metadata.order, 'newest');
      assert.deepEqual(newest.structuredContent.data.map((j) => j.title), ['New Role', 'Old Role', 'Undated Role']);
      const asBoard = await fetchJobs(client, { company: 'zzzorderco', order: 'board' });
      assert.equal(asBoard.structuredContent.metadata.order, 'board');
      assert.deepEqual(asBoard.structuredContent.data.map((j) => j.title), ['Old Role', 'New Role', 'Undated Role']);
      assert.equal(asBoard.structuredContent.metadata.registry_hit, false);
    } finally {
      if (prev === undefined) delete process.env.JD_INTEL_REGISTRY_URL;
      else process.env.JD_INTEL_REGISTRY_URL = prev;
    }
  });

  test('offset, order and max_tokens outside their ranges are rejected with text naming the field', async () => {
    const client = await connect({ fetchJobsDetailed: pagedLibrary(BOARD), findAtsBySlug: async () => 'greenhouse' });
    const bad = [
      [{ company: 'acme', offset: -1 }, /offset/],
      [{ company: 'acme', order: 'oldest' }, /order/],
      [{ company: 'acme', max_tokens: 100 }, /max_tokens/],
      [{ company: 'acme', max_tokens: 50_000 }, /max_tokens/],
    ];
    for (const [args, pattern] of bad) {
      const result = await client.callTool({ name: 'fetch_jobs', arguments: args });
      assert.equal(result.isError, true, JSON.stringify(args));
      assert.match(result.content[0].text, pattern);
    }
  });
});
