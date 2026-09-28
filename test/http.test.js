import { test, describe, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { atsFetch, configureHttp, probeResult } from '../src/http.js';
import { AtsError } from '../src/errors.js';
import { isAtsError, networkError } from './helpers.js';

/**
 * atsFetch is the one door every adapter request goes through (issue #7).
 * These tests pin its contract: which statuses and errors are retried, how
 * long it waits between attempts, what it throws once the attempts are
 * used up, and how many requests it lets a host see at once.
 *
 * `sleep` is injected so the backoff schedule is asserted, not waited for.
 * Every test sets its own settings; the defaults come back afterwards.
 */

const URL_A = 'https://api.example.test/boards/acme';

const ok = (body = {}) => ({ ok: true, status: 200, json: async () => body });
const status = (code, headers) => ({ ok: code >= 200 && code < 300, status: code, headers, json: async () => ({}) });

// Returns a fetch mock that answers `responses` in order (a function throws
// or returns), then keeps returning the last one. Records every call.
//
// A second sequence() in the same test would stack on the first, and the
// tracker restores mocks in creation order, so the middle one would still be
// installed after the test and reach the local-server tests below. Restore
// the current mock first so each one wraps the real fetch.
function sequence(t, responses) {
  const calls = [];
  globalThis.fetch.mock?.restore();
  t.mock.method(global, 'fetch', async (url, init) => {
    calls.push({ url: String(url), init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return typeof next === 'function' ? next() : next;
  });
  return calls;
}

function recordSleeps(overrides = {}) {
  const sleeps = [];
  configureHttp({ sleep: async (ms) => { sleeps.push(ms); }, ...overrides });
  return sleeps;
}

beforeEach(() => configureHttp());
after(() => configureHttp());

describe('atsFetch: pass-through', () => {
  test('a 2xx resolves with the response after one request', async (t) => {
    const calls = sequence(t, [ok({ jobs: [] })]);
    const resp = await atsFetch(URL_A);
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { jobs: [] });
    assert.equal(calls.length, 1);
  });

  test('forwards init and adds a timeout signal', async (t) => {
    const calls = sequence(t, [ok()]);
    await atsFetch(URL_A, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"a":1}', redirect: 'follow' });
    const { init } = calls[0];
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/json');
    assert.equal(init.body, '{"a":1}');
    assert.equal(init.redirect, 'follow');
    assert.ok(init.signal instanceof AbortSignal);
  });

  test('a 404 and a 400 resolve as they are, with no retry', async (t) => {
    const sleeps = recordSleeps();
    for (const code of [404, 400, 401, 403, 422]) {
      const calls = sequence(t, [status(code)]);
      const resp = await atsFetch(URL_A);
      assert.equal(resp.status, code);
      assert.equal(calls.length, 1, `status ${code} must not be retried`);
    }
    assert.deepEqual(sleeps, []);
  });

  test('reads the global fetch at call time, so a later mock applies', async (t) => {
    const first = sequence(t, [status(404)]);
    await atsFetch(URL_A);
    const second = sequence(t, [ok()]);
    const resp = await atsFetch(URL_A);
    assert.equal(resp.status, 200);
    assert.equal(first.length, 1);
    assert.equal(second.length, 1);
  });
});

describe('atsFetch: retries', () => {
  test('retries a 429 and honors Retry-After in seconds', async (t) => {
    const sleeps = recordSleeps();
    const calls = sequence(t, [status(429, new Headers({ 'Retry-After': '2' })), ok()]);
    const resp = await atsFetch(URL_A);
    assert.equal(resp.status, 200);
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [2000]);
  });

  test('honors Retry-After as an HTTP-date', async (t) => {
    const sleeps = recordSleeps();
    const date = new Date(Date.now() + 5000).toUTCString();
    sequence(t, [status(429, new Headers({ 'Retry-After': date })), ok()]);
    await atsFetch(URL_A);
    assert.equal(sleeps.length, 1);
    // toUTCString drops the milliseconds, so allow a second of slack below.
    assert.ok(sleeps[0] > 3900 && sleeps[0] <= 5000, `expected about 5s, got ${sleeps[0]}ms`);
  });

  test('caps Retry-After at 30 seconds and treats a past date as zero', async (t) => {
    const sleeps = recordSleeps();
    sequence(t, [status(429, new Headers({ 'Retry-After': '120' })), ok()]);
    await atsFetch(URL_A);
    sequence(t, [status(503, new Headers({ 'Retry-After': new Date(Date.now() - 60_000).toUTCString() })), ok()]);
    await atsFetch(URL_A);
    assert.deepEqual(sleeps, [30_000, 0]);
  });

  test('retries a 503 with backoff then returns the success', async (t) => {
    const sleeps = recordSleeps();
    const calls = sequence(t, [status(503), ok()]);
    const resp = await atsFetch(URL_A);
    assert.equal(resp.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(sleeps.length, 1);
    assert.ok(sleeps[0] >= 1000 && sleeps[0] < 1250, `first backoff ${sleeps[0]}ms`);
  });

  test('retries a network TypeError then returns the success', async (t) => {
    const sleeps = recordSleeps();
    const calls = sequence(t, [() => { throw networkError('ECONNRESET'); }, ok()]);
    const resp = await atsFetch(URL_A);
    assert.equal(resp.status, 200);
    assert.equal(calls.length, 2);
    assert.equal(sleeps.length, 1);
  });

  test('backoff doubles per attempt with a little jitter: 1s, 2s, 4s', async (t) => {
    const sleeps = recordSleeps({ retries: 4 });
    sequence(t, [status(503)]);
    await assert.rejects(atsFetch(URL_A), isAtsError('ats_unreachable', 503));
    assert.equal(sleeps.length, 3);
    for (const [i, base] of [1000, 2000, 4000].entries()) {
      assert.ok(sleeps[i] >= base && sleeps[i] < base + 250, `sleep ${i} was ${sleeps[i]}ms, expected ${base}ms plus jitter`);
    }
  });

  test('retries: 1 means a single attempt', async (t) => {
    const sleeps = recordSleeps({ retries: 1 });
    const calls = sequence(t, [status(503)]);
    await assert.rejects(atsFetch(URL_A), isAtsError('ats_unreachable', 503));
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
  });
});

describe('atsFetch: exhausted retries', () => {
  test('three 429s throw rate_limited with the status and the host', async (t) => {
    recordSleeps();
    const calls = sequence(t, [status(429)]);
    await assert.rejects(atsFetch(URL_A), (err) => {
      isAtsError('rate_limited', 429)(err);
      assert.match(err.message, /api\.example\.test/);
      assert.match(err.message, /HTTP 429 after 3 attempts/);
      return true;
    });
    assert.equal(calls.length, 3);
  });

  test('three 5xx answers throw ats_unreachable with the status', async (t) => {
    recordSleeps();
    for (const code of [500, 502, 503, 529]) {
      const calls = sequence(t, [status(code)]);
      await assert.rejects(atsFetch(URL_A), isAtsError('ats_unreachable', code));
      assert.equal(calls.length, 3, `status ${code}`);
    }
  });

  test('a certificate failure is thrown at once, with no retry', async (t) => {
    const sleeps = recordSleeps();
    for (const code of ['ERR_TLS_CERT_ALTNAME_INVALID', 'CERT_HAS_EXPIRED', 'SELF_SIGNED_CERT_IN_CHAIN']) {
      const calls = sequence(t, [() => { throw networkError(code); }]);
      await assert.rejects(atsFetch('https://bad-cert.example.test/x'), (err) => {
        isAtsError('ats_unreachable', undefined)(err);
        assert.match(err.message, new RegExp(`^bad-cert\\.example\\.test: fetch failed \\(${code}\\) after 1 attempt$`));
        return true;
      });
      assert.equal(calls.length, 1, code);
    }
    assert.deepEqual(sleeps, []);
  });

  test('a network error on every attempt throws ats_unreachable naming the host and the cause', async (t) => {
    recordSleeps();
    const calls = sequence(t, [() => { throw networkError('ENOTFOUND'); }]);
    await assert.rejects(atsFetch(URL_A), (err) => {
      isAtsError('ats_unreachable', undefined)(err);
      assert.match(err.message, /^api\.example\.test: fetch failed \(ENOTFOUND\) after 3 attempts$/);
      assert.equal(err.cause.cause.code, 'ENOTFOUND');
      return true;
    });
    assert.equal(calls.length, 3);
  });
});

describe('atsFetch: timeout', () => {
  // Rejects with the signal's reason when the timeout fires, the way undici
  // does (the local-server tests below check that against the real thing).
  const hangs = (url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });

  test('an attempt that outlasts timeoutMs throws ats_unreachable naming the host', async (t) => {
    configureHttp({ timeoutMs: 20, retries: 1, sleep: async () => {} });
    t.mock.method(global, 'fetch', hangs);
    await assert.rejects(atsFetch('https://slow.example.test/feed'), (err) => {
      isAtsError('ats_unreachable', undefined)(err);
      assert.match(err.message, /^slow\.example\.test: timed out after 20ms after 1 attempt$/);
      return true;
    });
  });

  test('a timeout is retried like a network error', async (t) => {
    const sleeps = recordSleeps({ timeoutMs: 20 });
    let calls = 0;
    t.mock.method(global, 'fetch', async (url, init) => {
      calls += 1;
      return calls === 1 ? hangs(url, init) : ok();
    });
    const resp = await atsFetch(URL_A);
    assert.equal(resp.status, 200);
    assert.equal(calls, 2);
    assert.equal(sleeps.length, 1);
  });

  test('the signal is released once the response arrives, so a slow body read is not aborted', async (t) => {
    configureHttp({ timeoutMs: 20, retries: 1, sleep: async () => {} });
    let signal;
    t.mock.method(global, 'fetch', async (url, init) => {
      signal = init.signal;
      return ok();
    });
    await atsFetch(URL_A);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(signal.aborted, false);
  });
});

describe('atsFetch: timeout against a local server', () => {
  // The mocks above cover the retry path. These cover undici's side of the
  // contract with a real request: an aborted request rejects with the
  // timer's reason, and once the headers are in, the body is read in full
  // however long it takes.
  async function serve(t, handler) {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => {
      server.closeAllConnections();
      server.close();
    });
    return `http://127.0.0.1:${server.address().port}`;
  }

  test('a body that arrives after timeoutMs is still read in full', async (t) => {
    configureHttp({ timeoutMs: 300, retries: 1, sleep: async () => {} });
    const base = await serve(t, (req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.flushHeaders(); // writeHead alone holds the headers back until the first write
      setTimeout(() => res.end('{"jobs":[]}'), 700);
    });
    const resp = await atsFetch(`${base}/boards/acme/jobs`);
    assert.equal(resp.status, 200);
    assert.deepEqual(await resp.json(), { jobs: [] });
  });

  test('no response headers within timeoutMs throws ats_unreachable naming the host', async (t) => {
    configureHttp({ timeoutMs: 100, retries: 1, sleep: async () => {} });
    const base = await serve(t, () => {}); // never answers
    await assert.rejects(atsFetch(`${base}/boards/acme/jobs`), (err) => {
      isAtsError('ats_unreachable', undefined)(err);
      assert.match(err.message, /^127\.0\.0\.1: timed out after 100ms after 1 attempt$/);
      return true;
    });
  });
});

describe('atsFetch: per-host concurrency', () => {
  // A fetch mock that takes a few ms and tracks how many calls overlap.
  function gauge(t) {
    const seen = { inFlight: 0, peak: 0, byHost: {}, peakByHost: {} };
    t.mock.method(global, 'fetch', async (url) => {
      const host = new URL(url).hostname.split('.')[0];
      seen.inFlight += 1;
      seen.byHost[host] = (seen.byHost[host] || 0) + 1;
      seen.peak = Math.max(seen.peak, seen.inFlight);
      seen.peakByHost[host] = Math.max(seen.peakByHost[host] || 0, seen.byHost[host]);
      await new Promise((r) => setTimeout(r, 5));
      seen.inFlight -= 1;
      seen.byHost[host] -= 1;
      return ok();
    });
    return seen;
  }

  test('never has more than 4 requests in flight to one host', async (t) => {
    const seen = gauge(t);
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => atsFetch(`${URL_A}/${i}`)));
    assert.equal(results.length, 12);
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(seen.peak, 4);
    assert.equal(seen.inFlight, 0);
  });

  test('the cap is per host, so two hosts run side by side', async (t) => {
    const seen = gauge(t);
    await Promise.all([
      ...Array.from({ length: 6 }, (_, i) => atsFetch(`https://one.example.test/${i}`)),
      ...Array.from({ length: 6 }, (_, i) => atsFetch(`https://two.example.test/${i}`)),
    ]);
    assert.equal(seen.peak, 8, 'both hosts fill their own four slots at once');
    assert.ok(seen.peakByHost.one <= 4 && seen.peakByHost.two <= 4, JSON.stringify(seen.peakByHost));
  });

  test('a caller arriving while a waiter is being woken does not slip past the cap', async (t) => {
    // A finished request hands its slot to the next waiter before the new
    // caller runs. If the count dipped in between, the newcomer would see a
    // free slot that the woken waiter is about to use, and 5 would overlap.
    const seen = gauge(t);
    const first = Array.from({ length: 8 }, (_, i) => atsFetch(`${URL_A}/first/${i}`));
    const late = first[0].then(() => Promise.all(Array.from({ length: 4 }, (_, i) => atsFetch(`${URL_A}/late/${i}`))));
    await Promise.all([...first, late]);
    assert.equal(seen.peak, 4);
  });

  test('a waiting request still runs after the one ahead of it fails', async (t) => {
    configureHttp({ perHost: 1, retries: 1, sleep: async () => {} });
    let calls = 0;
    t.mock.method(global, 'fetch', async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 2));
      if (calls === 1) throw networkError();
      return ok();
    });
    const [first, second] = await Promise.allSettled([atsFetch(URL_A), atsFetch(URL_A)]);
    assert.equal(first.status, 'rejected');
    assert.ok(first.reason instanceof AtsError);
    assert.equal(second.status, 'fulfilled');
    assert.equal(second.value.status, 200);
  });
});

describe('configureHttp', () => {
  test('returns the settings in force and resets to the defaults when called bare', () => {
    const custom = configureHttp({ retries: 1, timeoutMs: 5 });
    assert.equal(custom.retries, 1);
    assert.equal(custom.timeoutMs, 5);
    assert.equal(custom.perHost, 4);
    const defaults = configureHttp();
    assert.equal(defaults.timeoutMs, 10_000);
    assert.equal(defaults.retries, 3);
    assert.equal(defaults.perHost, 4);
    assert.equal(typeof defaults.sleep, 'function');
  });
});

describe('probeResult', () => {
  test('true on 2xx, false on 404, throws with the status on anything else', () => {
    assert.equal(probeResult(status(200), 'probe'), true);
    assert.equal(probeResult(status(204), 'probe'), true);
    assert.equal(probeResult(status(404), 'probe'), false);
    for (const code of [401, 403, 422]) {
      assert.throws(() => probeResult(status(code), 'Acme probe'), (err) => {
        isAtsError('ats_unreachable', code)(err);
        assert.equal(err.message, `Acme probe: ${code}`);
        return true;
      });
    }
  });
});
