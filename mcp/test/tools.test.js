import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { registerTools } from '../tools.js';
import { success, error, envelopeSchema } from '../envelope.js';
import { AtsError } from 'jd-intel';

/**
 * First automated MCP test. Uses the registerTools(server, deps) seam to
 * inject a mock library, so this is offline and asserts the AI-facing
 * contract: how the `workday` arg maps to the library `fetchJobs` call,
 * the envelope metadata, and the error-code taxonomy.
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
      fetchJobs: async (opts) => { received = opts; return [{ title: 'PM' }]; },
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
      fetchJobs: async (opts) => { received = opts; return []; },
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

  test('incomplete (whitespace) workday triple -> invalid_args, fetchJobs not called', async () => {
    let called = false;
    const handler = getFetchJobsHandler({
      fetchJobs: async () => { called = true; return []; },
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
      fetchJobs: async () => { throw new AtsError('ats_unreachable', 'Workday API error for x (a/b/c): 422'); },
      findAtsBySlug: async () => null,
    });
    const result = await handler({ company: 'x', workday: { tenant: 'a', env: 'b', site: 'c' } });
    const env = parse(result);
    assert.equal(env.status, 'error');
    assert.equal(env.error.code, 'ats_unreachable');
  });

  test('generic library error without workday still maps to invalid_args', async () => {
    const handler = getFetchJobsHandler({
      fetchJobs: async () => { throw new Error('Company slug required'); },
      findAtsBySlug: async () => null,
    });
    const result = await handler({ company: '' });
    const env = parse(result);
    assert.equal(env.status, 'error');
    assert.equal(env.error.code, 'invalid_args');
  });

  test('success metadata carries the server version and registry source', async () => {
    const handler = getFetchJobsHandler({
      fetchJobs: async () => [{ title: 'PM' }],
      findAtsBySlug: async () => 'greenhouse',
    });
    const env = parse(await handler({ company: 'stripe' }));
    assert.equal(env.status, 'success');
    assert.match(env.metadata.version, /^\d+\.\d+\.\d+/);
    assert.equal(typeof env.metadata.registry_source, 'string');
  });

  test('rate-limited adapter error -> rate_limited', async () => {
    const handler = getFetchJobsHandler({
      fetchJobs: async () => { throw new AtsError('rate_limited', 'Greenhouse API error for stripe: 429'); },
      findAtsBySlug: async () => 'greenhouse',
    });
    const env = parse(await handler({ company: 'stripe' }));
    assert.equal(env.status, 'error');
    assert.equal(env.error.code, 'rate_limited');
  });

  test('non-429 adapter API error -> ats_unreachable', async () => {
    const handler = getFetchJobsHandler({
      fetchJobs: async () => { throw new AtsError('ats_unreachable', 'Lever API error for foo: 500'); },
      findAtsBySlug: async () => 'lever',
    });
    const env = parse(await handler({ company: 'foo' }));
    assert.equal(env.status, 'error');
    assert.equal(env.error.code, 'ats_unreachable');
  });

  test('a non-AtsError (plain Error) maps to invalid_args', async () => {
    const handler = getFetchJobsHandler({
      fetchJobs: async () => { throw new Error('some unexpected failure'); },
      findAtsBySlug: async () => 'greenhouse',
    });
    const env = parse(await handler({ company: 'stripe' }));
    assert.equal(env.error.code, 'invalid_args');
  });

  test('discovery miss (no registry hit, no jobs) -> company_not_found', async () => {
    const handler = getFetchJobsHandler({
      fetchJobs: async () => [],
      findAtsBySlug: async () => null,
    });
    const env = parse(await handler({ company: 'zzzznotacompany' }));
    assert.equal(env.status, 'error');
    assert.equal(env.error.code, 'company_not_found');
  });

  test('registry hit with zero open roles stays success([])', async () => {
    const handler = getFetchJobsHandler({
      fetchJobs: async () => [],
      findAtsBySlug: async () => 'greenhouse',
    });
    const env = parse(await handler({ company: 'stripe' }));
    assert.equal(env.status, 'success');
    assert.equal(env.data.length, 0);
    assert.equal(env.metadata.registry_hit, true);
  });

  test('workday override returning zero jobs stays success (not company_not_found)', async () => {
    const handler = getFetchJobsHandler({
      fetchJobs: async () => [],
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
      fetchJobs: async () => [{ title: 'PM' }],
      findAtsBySlug: async () => 'greenhouse',
    });
    const result = await handler({ company: 'stripe' });
    assert.deepEqual(result.structuredContent, parse(result));
    assert.equal(result.isError, undefined);
  });

  test('error sets isError and keeps the structured error code', async () => {
    const handler = getFetchJobsHandler({
      fetchJobs: async () => [],
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
      fetchJobs: async () => [job],
      findAtsBySlug: async () => 'greenhouse',
    });
    const result = await client.callTool({ name: 'fetch_jobs', arguments: { company: 'stripe' } });
    assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent.status, 'success');
    assert.equal(result.structuredContent.data[0].title, 'PM');
    assert.equal(result.structuredContent.data[0].companySlug, 'stripe');
  });

  test('fetch_jobs error envelope passes client-side validation and sets isError', async () => {
    const client = await connect({ fetchJobs: async () => [], findAtsBySlug: async () => null });
    const result = await client.callTool({ name: 'fetch_jobs', arguments: { company: 'zzzz' } });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.status, 'error');
    assert.equal(result.structuredContent.data, null);
    assert.equal(result.structuredContent.error.code, 'company_not_found');
  });

  test('fetch_jobs unknown argument is rejected with text naming it', async () => {
    const client = await connect({ fetchJobs: async () => [job], findAtsBySlug: async () => 'greenhouse' });
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
      ['fetch_jobs', { fetchJobs: thrower, findAtsBySlug: async () => null }, { company: 'acme' }],
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
