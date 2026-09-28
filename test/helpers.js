import { test } from 'node:test';
import assert from 'node:assert/strict';
import { configureHttp } from '../src/http.js';
import { AtsError } from '../src/errors.js';

/**
 * Shared helpers for the adapter tests. Not a test file: the suite's glob
 * is test/*.test.js.
 */

/**
 * One attempt per request and no waiting, so a test that answers 429 or
 * 5xx sees exactly one fetch call and runs at full speed. The retry
 * behavior itself is covered in http.test.js. Call once at the top of a
 * test file; every file runs in its own process.
 */
export function disableRetries() {
  configureHttp({ retries: 1, sleep: async () => {} });
}

/**
 * What undici throws when the socket fails: a TypeError with the OS code
 * on `cause`.
 */
export function networkError(code = 'ECONNRESET') {
  return Object.assign(new TypeError('fetch failed'), { cause: { code } });
}

/**
 * Validator for assert.rejects: the rejection is an AtsError with this
 * code and status (status undefined for a network error or timeout).
 */
export function isAtsError(code, status) {
  return (err) => {
    assert.ok(err instanceof AtsError, `expected AtsError, got ${err?.name}: ${err?.message}`);
    assert.equal(err.code, code);
    assert.equal(err.status, status);
    return true;
  };
}

/**
 * Registers the failure cases every probeable has() shares (issue #55):
 * when the first response is a 429, 503, 403 or a network error, has()
 * throws the matching AtsError instead of answering false. Call inside the
 * adapter's has() describe, in a file that called disableRetries().
 */
export function probeFailureTests(has, slug) {
  for (const [status, code] of [[429, 'rate_limited'], [503, 'ats_unreachable'], [403, 'ats_unreachable']]) {
    test(`throws ${code} carrying the status on a ${status}`, async (t) => {
      t.mock.method(global, 'fetch', async () => ({ ok: false, status, json: async () => ({}), text: async () => '' }));
      await assert.rejects(has(slug), isAtsError(code, status));
    });
  }

  test('throws ats_unreachable naming the cause on a network error', async (t) => {
    t.mock.method(global, 'fetch', async () => { throw networkError('ENOTFOUND'); });
    await assert.rejects(has(slug), (err) => {
      isAtsError('ats_unreachable', undefined)(err);
      assert.match(err.message, /ENOTFOUND/);
      return true;
    });
  });
}
