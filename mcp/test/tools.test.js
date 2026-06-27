import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { registerTools } from '../tools.js';
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
