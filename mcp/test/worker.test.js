import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

// The Workers entry point, driven with web-standard Request objects. The
// transport is the SDK's web-standard one, so this runs in Node as is.
const rpc = (body) => worker.fetch(new Request('https://jd-intel.example/mcp', {
  method: 'POST',
  headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify(body),
}));

describe('worker', () => {
  test('answers initialize and tools/list over Streamable HTTP, stateless', async () => {
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } } });
    assert.equal(init.status, 200);
    assert.equal((await init.json()).result.serverInfo.name, 'jd-intel');
    assert.equal(init.headers.get('mcp-session-id'), null, 'no session: every request stands alone');

    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    assert.deepEqual((await list.json()).result.tools.map((t) => t.name).sort(), ['detect_ats', 'fetch_jobs', 'search_registry']);
  });

  test('anything but /mcp is a 404 that names the endpoint', async () => {
    const res = await worker.fetch(new Request('https://jd-intel.example/'));
    assert.equal(res.status, 404);
    assert.match(await res.text(), /\/mcp/);
  });
});
